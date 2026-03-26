import React, { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Cell,
} from "recharts";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

type ChartMode = "monthly" | "annual";
type DrawMode = "point" | "rect";
type StatusData = { loaded: boolean; loadError: string | null; loadProgress: string; nTimes: number };
type SeriesPoint = { date?: string; lwe: number | null; year?: number };
interface QueryResult {
  lat?: number; lon?: number;
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  nGridCells?: number;
  cells?: { lat: number; lon: number }[];
  monthly: SeriesPoint[];
  annual: SeriesPoint[];
}

// TerraClimate types
interface TCVarSeries {
  monthly: { month: string; value: number | null }[];
  annual: { year: number; value: number | null }[];
  monthly_means: (number | null)[];
}
interface TCResult {
  lat?: number; lon?: number;
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  variables: { ppt: TCVarSeries; aet: TCVarSeries; q: TCVarSeries };
}

const GRACE_PANEL_W = 380;
const TC_PANEL_W = 320;
const HDR_H = 56;
const GEO_H = 0; // geology moved into GRACE panel — no bottom strip

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

async function geocode(query: string): Promise<{ lat: number; lon: number; displayName: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": "GRACE-LWE-Explorer/1.0" } });
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), displayName: data[0].display_name };
}

export default function GraceExplorer() {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const clickMarkerRef = useRef<L.Marker | null>(null);
  const tileLayerRef = useRef<L.FeatureGroup | null>(null);
  const aoiLayerRef = useRef<L.FeatureGroup | null>(null);   // persistent AOI outline (never cleared by drawTiles)
  const rectPreviewRef = useRef<L.Rectangle | null>(null);
  const corner1Ref = useRef<L.LatLng | null>(null);
  const corner1MarkerRef = useRef<L.CircleMarker | null>(null);

  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(() => update());
    if (rootRef.current) ro.observe(rootRef.current);
    return () => { window.removeEventListener("resize", update); ro.disconnect(); };
  }, []);

  const mapW = size.w - GRACE_PANEL_W - TC_PANEL_W;
  const bodyH = size.h - HDR_H - GEO_H;

  const [chartMode, setChartMode] = useState<ChartMode>("annual");
  const [drawMode, setDrawMode] = useState<DrawMode>("point");
  const [rectStep, setRectStep] = useState<0 | 1>(0);
  const [pendingQuery, setPendingQuery] = useState<{ type: "point" | "bbox"; params: Record<string, number> } | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [locationName, setLocationName] = useState<string>("");
  const [searchText, setSearchText] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // TerraClimate state
  const [tcResult, setTcResult] = useState<TCResult | null>(null);
  const [tcLoading, setTcLoading] = useState(false);
  const [tcError, setTcError] = useState<string | null>(null);
  const [tcChartMode, setTcChartMode] = useState<"annual" | "monthly_series" | "monthly_mean">("annual");

  // Geology state
  const [geoSummary, setGeoSummary] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  // GRACE raster overlay
  const [graceRasterYear, setGraceRasterYear] = useState(2024);
  const [graceRasterOpacity, setGraceRasterOpacity] = useState(0);
  const graceImageOverlayRef = useRef<L.ImageOverlay | null>(null);
  const graceRasterOpacityRef = useRef(0);
  useEffect(() => { graceRasterOpacityRef.current = graceRasterOpacity; }, [graceRasterOpacity]);

  // Cache for raw grid data per year — so AOI stretch doesn't require a refetch
  type GraceGrid = { values: number[]; nLat: number; nLon: number; vmin: number; vmax: number };
  const graceGridCacheRef = useRef<Record<number, GraceGrid>>({});
  // Current AOI bounds — used only to derive which raster pixels are "inside" the AOI
  const graceAoiRef = useRef<{ minLat: number; maxLat: number; minLon: number; maxLon: number } | null>(null);
  // Raster visParams — derived from regional stats (mn/mx of queryResult.annual).
  // These are the SAME values shown in the Min/Max stats boxes in the GRACE panel.
  // lo  = series min  (maps to full blue)   — can be negative or positive
  // hi  = series max  (maps to full red)    — can be negative or positive
  // White point is always fixed at 0.
  const graceChartAbsMaxRef = useRef<number>(0); // symmetric absMax: max(|min|,|max|) — shared by raster + bar chart
  const graceVisParamsRef = useRef<{ absMax: number } | null>(null);
  // Legend state — driven by the same visParams
  const [graceLegendRange, setGraceLegendRange] = useState<{ lo: number; hi: number } | null>(null);

  // Geologic map overlay
  const [geoOpacity, setGeoOpacity] = useState(0);
  const macroLayerRef = useRef<L.TileLayer | null>(null);
  const geoOpacityRef = useRef(0);
  const geoPopupRef = useRef<L.Popup | null>(null);
  useEffect(() => { geoOpacityRef.current = geoOpacity; }, [geoOpacity]);

  // Color relief overlay (Terrarium elevation + ESRI hillshade)
  const [reliefOpacity, setReliefOpacity] = useState(0);
  const reliefColorLayerRef = useRef<L.TileLayer | null>(null);
  const reliefShadeLayerRef = useRef<L.TileLayer | null>(null);
  // Drainage / rivers overlay
  const [riversOn, setRiversOn] = useState(false);
  const riversLayerRef = useRef<L.TileLayer | null>(null);

  // Watershed toggles: L5 (coarse), L6, L7 (fine) — from WWF HydroSHEDS
  const [wsL5On, setWsL5On] = useState(false);
  const [wsL6On, setWsL6On] = useState(false);
  const [wsL7On, setWsL7On] = useState(false);
  const wsL5OnRef = useRef(false);
  const wsL6OnRef = useRef(false);
  const wsL7OnRef = useRef(false);
  useEffect(() => { wsL5OnRef.current = wsL5On; }, [wsL5On]);
  useEffect(() => { wsL6OnRef.current = wsL6On; }, [wsL6On]);
  useEffect(() => { wsL7OnRef.current = wsL7On; }, [wsL7On]);
  const wsL5Ref = useRef<L.GeoJSON | null>(null);
  const wsL6Ref = useRef<L.GeoJSON | null>(null);
  const wsL7Ref = useRef<L.GeoJSON | null>(null);
  const wsLoadingRef = useRef<{[k: string]: boolean}>({ l5: false, l6: false, l7: false });
  // Stable refs to fetch functions so the map moveend handler can call them
  const fetchWsL5Ref = useRef<(() => void) | null>(null);
  const fetchWsL6Ref = useRef<(() => void) | null>(null);
  const fetchWsL7Ref = useRef<(() => void) | null>(null);

  const drawModeRef = useRef<DrawMode>("point");
  const rectStepRef = useRef<0 | 1>(0);
  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { rectStepRef.current = rectStep; }, [rectStep]);

  const { data: status } = useQuery<StatusData>({
    queryKey: ["/api/status"],
    refetchInterval: (q) => ((q.state.data as StatusData | undefined)?.loaded ? false : 3000),
  });

  useEffect(() => {
    if (!pendingQuery || !status?.loaded) return;
    runQuery(pendingQuery);
    runGeoQuery(pendingQuery);
    // TC data is NOT auto-fetched — user clicks the button in the TC panel
    setTcResult(null);
    setTcError(null);
  }, [pendingQuery, status?.loaded]);

  // Render GRACE raster once data is loaded, and re-render when year changes
  useEffect(() => {
    if (!status?.loaded) return;
    renderGraceRaster(graceRasterYear, graceRasterOpacity);
  }, [status?.loaded, graceRasterYear]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update opacity without re-rendering canvas
  useEffect(() => {
    if (graceImageOverlayRef.current) {
      graceImageOverlayRef.current.setOpacity(graceRasterOpacity);
    }
  }, [graceRasterOpacity]);

  // Draw persistent AOI outline only (GRACE pixel tiles removed per user request)
  // originalCoords = the actual click/search coords (not GRACE-snapped) for TC AOI placement
  const drawTiles = useCallback((result: QueryResult, originalCoords?: { lat: number; lon: number }) => {
    if (!leafletMap.current) return;

    // ── AOI / TerraClimate bounding box (separate layer, always on top) ──
    if (!aoiLayerRef.current) {
      aoiLayerRef.current = new L.FeatureGroup().addTo(leafletMap.current);
    } else {
      aoiLayerRef.current.clearLayers();
    }
    const TC_HALF = 1 / 48; // half of 1/24° TC cell
    if (result.bbox) {
      // Region AOI: draw the user's drawn rectangle
      const { minLat, maxLat, minLon, maxLon } = result.bbox;
      L.rectangle([[minLat, minLon], [maxLat, maxLon]], {
        color: "#2563eb", weight: 2.5, dashArray: "6 3",
        fill: true, fillColor: "#3b82f6", fillOpacity: 0.12, interactive: false,
      }).addTo(aoiLayerRef.current!);
    } else if (result.lat !== undefined && result.lon !== undefined) {
      // Point AOI: tiny box at the ORIGINAL click location (not GRACE-snapped)
      const lat = originalCoords?.lat ?? result.lat;
      const lon = originalCoords?.lon ?? result.lon;
      L.rectangle(
        [[lat - TC_HALF, lon - TC_HALF], [lat + TC_HALF, lon + TC_HALF]],
        { color: "#2563eb", weight: 2, fill: true, fillColor: "#3b82f6", fillOpacity: 0.30, interactive: false }
      ).addTo(aoiLayerRef.current!);
    }
  }, []);

  // ── GRACE raster renderer ─────────────────────────────────────────────────
  // Rules (per user request):
  //   1. ONLY renders when an AOI is set — no global raster.
  //   2. Clips strictly to the AOI bbox — only pixels inside the rectangle are
  //      coloured; the overlay itself is bounded to that bbox so nothing outside
  //      is visible.
  //   3. Color ramp uses graceVisParamsRef (absMax = max(|min|,|max|)) — the
  //      EXACT same values shown as Min/Max in the regional stats box.
  //   4. White point is fixed at 0 (asymmetric ramp: blue side spans 0→lo,
  //      red side spans 0→hi).
  const renderGraceRaster = useCallback(async (year: number, opacity: number) => {
    if (!leafletMap.current) return;

    // No AOI — remove any existing overlay and stop.
    const aoi = graceAoiRef.current;
    if (!aoi) {
      if (graceImageOverlayRef.current) { graceImageOverlayRef.current.remove(); graceImageOverlayRef.current = null; }
      return;
    }

    const API_BASE_R = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
    try {
      // ── Fetch or use cached grid ─────────────────────────────────────────
      let grid = graceGridCacheRef.current[year];
      if (!grid) {
        const resp = await fetch(`${API_BASE_R}/api/grace-raster?year=${year}`);
        if (!resp.ok) return;
        const raw = await resp.json() as { values: number[]; nLat: number; nLon: number; vmin: number; vmax: number };
        grid = { values: raw.values, nLat: raw.nLat, nLon: raw.nLon, vmin: raw.vmin, vmax: raw.vmax };
        graceGridCacheRef.current[year] = grid;
      }
      const { values, nLat, nLon } = grid;

      // ── visParams: symmetric ±absMax (same scale as bar chart Y-axis) ────────
      // min = -absMax → full blue (#0000ff)
      // 0            → white   (#ffffff)
      // max = +absMax → full red  (#ff0000)
      const vp = graceVisParamsRef.current;
      const absMax = vp ? vp.absMax : Math.max(Math.abs(grid.vmin), Math.abs(grid.vmax), 0.01);

      // ── Determine which grid rows/cols fall inside the AOI ───────────────
      // Grid: row 0 = 89.75°N, step −0.5° — col 0 = −179.75°, step +0.5°
      const latStep = 0.5, lonStep = 0.5;
      const gridNorth = 89.75, gridWest = -179.75;

      // AOI pixel range (inclusive, with 0.25° snap tolerance)
      const rowMin = Math.max(0, Math.floor((gridNorth - aoi.maxLat) / latStep));
      const rowMax = Math.min(nLat - 1, Math.ceil((gridNorth - aoi.minLat) / latStep));
      const colMin = Math.max(0, Math.floor((aoi.minLon - gridWest) / lonStep));
      const colMax = Math.min(nLon - 1, Math.ceil((aoi.maxLon - gridWest) / lonStep));

      const outRows = rowMax - rowMin + 1;
      const outCols = colMax - colMin + 1;
      if (outRows <= 0 || outCols <= 0) return;

      // ── Paint clipped canvas ──────────────────────────────────────────
      const canvas = document.createElement('canvas');
      canvas.width = outCols;
      canvas.height = outRows;
      const ctx = canvas.getContext('2d')!;
      const imgData = ctx.createImageData(outCols, outRows);
      const d = imgData.data;

      for (let or = 0; or < outRows; or++) {
        const gridRow = rowMin + or;
        for (let oc = 0; oc < outCols; oc++) {
          const gridCol = colMin + oc;
          const v = values[gridRow * nLon + gridCol];
          const px = (or * outCols + oc) * 4;
          if (v === -99999) {
            d[px] = 0; d[px+1] = 0; d[px+2] = 0; d[px+3] = 0; // transparent
            continue;
          }
          // Symmetric scale: -absMax→blue(0,0,255)  0→white(255,255,255)  +absMax→red(255,0,0)
          const s = Math.min(1, Math.abs(v) / absMax); // normalised intensity [0,1]
          let r: number, g: number, b: number;
          if (v <= 0) {
            // Negative → interpolate white→blue
            r = Math.round(255 * (1 - s));
            g = Math.round(255 * (1 - s));
            b = 255;
          } else {
            // Positive → interpolate white→red
            r = 255;
            g = Math.round(255 * (1 - s));
            b = Math.round(255 * (1 - s));
          }
          d[px] = r; d[px+1] = g; d[px+2] = b; d[px+3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');

      // ── Compute exact geographic bounds of the clipped canvas ────────────
      // Pixel centres: north edge of row rowMin, south edge of row rowMax,
      // west edge of col colMin, east edge of col colMax.
      const imgNorth = gridNorth - rowMin * latStep + latStep / 2;
      const imgSouth = gridNorth - rowMax * latStep - latStep / 2;
      const imgWest  = gridWest  + colMin * lonStep - lonStep / 2;
      const imgEast  = gridWest  + colMax * lonStep + lonStep / 2;

      // ── Place as Leaflet ImageOverlay clipped to AOI ───────────────────
      if (graceImageOverlayRef.current) graceImageOverlayRef.current.remove();
      const overlay = L.imageOverlay(dataUrl, [[imgSouth, imgWest], [imgNorth, imgEast]], {
        opacity,
        zIndex: 195,
        interactive: false,
        className: 'grace-raster-overlay',
      });
      overlay.addTo(leafletMap.current);
      graceImageOverlayRef.current = overlay;
    } catch (e) {
      console.error('[GRACE Raster]', e);
    }
  }, []); // all state read via stable refs — no stale closures

  // Expose a ref-stable re-render function so runQuery can call it after AOI update
  const renderGraceRasterRef = useRef(renderGraceRaster);
  useEffect(() => { renderGraceRasterRef.current = renderGraceRaster; }, [renderGraceRaster]);

  // Convert raw fetch/HTTP errors into user-friendly messages
  function friendlyError(e: any): string {
    const msg: string = String(e?.message ?? e ?? "");
    // apiRequest throws "502: <!DOCTYPE..." or "503: ..." before returning
    const codeMatch = msg.match(/^(\d{3})/);
    const status = codeMatch ? parseInt(codeMatch[1], 10) : 0;
    if (status === 502 || status === 503)
      return "Server is waking up — please wait ~30 seconds and click again.";
    if (status === 504)
      return "Request timed out — server may be starting, please try again.";
    if (status === 500)
      return "Server error — please try again.";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError"))
      return "Network error — check your connection and try again.";
    return msg;
  }

  const runQuery = useCallback(async (q: { type: "point" | "bbox"; params: Record<string, number> }) => {
    setQueryLoading(true);
    setQueryError(null);
    try {
      const ps = new URLSearchParams(Object.entries(q.params).map(([k, v]) => [k, String(v)]));
      const url = q.type === "point" ? `/api/query/point?${ps}` : `/api/query/bbox?${ps}`;
      const res = await apiRequest("GET", url);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setQueryResult(data);
      // Pass original coords so TC AOI box lands on the actual click, not the GRACE-snapped cell
      const orig = q.type === "point" ? { lat: q.params.lat, lon: q.params.lon } : undefined;
      drawTiles(data, orig);

      // ── visParams: exact regional stats (lo=seriesMin, hi=seriesMax) ────────
      // These are the SAME values the stats box shows as Min/Max.
      // lo → full blue endpoint, hi → full red endpoint, 0 always = white.
      const annualVals = (data.annual as SeriesPoint[])
        .map((d) => d.lwe)
        .filter((v): v is number => v !== null && v !== undefined);
      if (annualVals.length > 0) {
        const seriesMin = Math.min(...annualVals);
        const seriesMax = Math.max(...annualVals);
        // Unified symmetric scale: absMax = max(|min|, |max|)
        // Raster: visParams min=-absMax, max=+absMax (0 always = white)
        // Bar chart: YAxis domain [-absMax, +absMax]
        // Legend: colour ramp ±absMax but labels show actual lo/hi
        const newAbsMax = Math.max(Math.abs(seriesMin), Math.abs(seriesMax), 0.01);
        graceVisParamsRef.current = { absMax: newAbsMax };
        graceChartAbsMaxRef.current = newAbsMax;
        setGraceLegendRange({ lo: seriesMin, hi: seriesMax });
      }

      // Store AOI bounds (still used for potential future spatial queries)
      if (data.bbox) {
        graceAoiRef.current = {
          minLat: data.bbox.minLat, maxLat: data.bbox.maxLat,
          minLon: data.bbox.minLon, maxLon: data.bbox.maxLon,
        };
      } else if (data.lat !== undefined && data.lon !== undefined) {
        graceAoiRef.current = {
          minLat: data.lat - 0.25, maxLat: data.lat + 0.25,
          minLon: data.lon - 0.25, maxLon: data.lon + 0.25,
        };
      }

      // Re-paint raster with the chart-matched scale (grid is cached, no re-fetch)
      renderGraceRasterRef.current(graceRasterYear, graceRasterOpacityRef.current);
    } catch (e: any) {
      setQueryError(friendlyError(e));
    } finally {
      setQueryLoading(false);
    }
  }, [drawTiles, graceRasterYear]);

  const runTCQuery = useCallback(async (q: { type: "point" | "bbox"; params: Record<string, number> }) => {
    setTcLoading(true);
    setTcError(null);
    setTcResult(null);
    try {
      const ps = new URLSearchParams(Object.entries(q.params).map(([k, v]) => [k, String(v)]));
      const url = q.type === "point" ? `/api/terraclimate/point?${ps}` : `/api/terraclimate/bbox?${ps}`;
      const res = await apiRequest("GET", url);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTcResult(data);
    } catch (e: any) {
      setTcError(friendlyError(e));
    } finally {
      setTcLoading(false);
    }
  }, []);

  const runGeoQuery = useCallback(async (q: { type: "point" | "bbox"; params: Record<string, number> }) => {
    setGeoLoading(true);
    setGeoError(null);
    setGeoSummary(null);
    try {
      const p = q.params;
      const ps = new URLSearchParams();
      if (q.type === "point") {
        ps.set("lat", String(p.lat));
        ps.set("lon", String(p.lon));
      } else {
        // Use center of bbox for lat/lon, plus bbox params
        ps.set("lat", String((p.minLat + p.maxLat) / 2));
        ps.set("lon", String((p.minLon + p.maxLon) / 2));
        ps.set("minLat", String(p.minLat));
        ps.set("maxLat", String(p.maxLat));
        ps.set("minLon", String(p.minLon));
        ps.set("maxLon", String(p.maxLon));
      }
      ps.set("name", locationName);
      const res = await apiRequest("GET", `/api/geology?${ps}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGeoSummary(data.summary);
    } catch (e: any) {
      setGeoError(friendlyError(e));
    } finally {
      setGeoLoading(false);
    }
  }, [locationName]);

  // Sync color relief overlay
  useEffect(() => {
    if (!leafletMap.current) return;
    if (reliefOpacity === 0) {
      if (reliefColorLayerRef.current) { leafletMap.current.removeLayer(reliefColorLayerRef.current); reliefColorLayerRef.current = null; }
      if (reliefShadeLayerRef.current) { leafletMap.current.removeLayer(reliefShadeLayerRef.current); reliefShadeLayerRef.current = null; }
    } else {
      const op = reliefOpacity / 100;
      // Color-by-elevation layer (OpenTopoMap — color hypsometry + hillshade baked in)
      if (!reliefColorLayerRef.current) {
        reliefColorLayerRef.current = L.tileLayer(
          "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
          { opacity: op, maxZoom: 17, subdomains: "abc",
            attribution: 'Relief &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)' }
        );
        reliefColorLayerRef.current.addTo(leafletMap.current);
        reliefColorLayerRef.current.setZIndex(190);
      } else {
        reliefColorLayerRef.current.setOpacity(op);
      }
      // ESRI hillshade on top for extra depth (low fixed opacity blended over color layer)
      if (!reliefShadeLayerRef.current) {
        reliefShadeLayerRef.current = L.tileLayer(
          "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
          { opacity: op * 0.35, maxZoom: 19,
            attribution: 'Hillshade &copy; <a href="https://www.esri.com/">Esri</a>' }
        );
        reliefShadeLayerRef.current.addTo(leafletMap.current);
        reliefShadeLayerRef.current.setZIndex(191);
      } else {
        reliefShadeLayerRef.current.setOpacity(op * 0.35);
      }
      // Keep layers in correct order: geology → rivers → AOI on top
      if (macroLayerRef.current)  macroLayerRef.current.setZIndex(200);
      if (riversLayerRef.current) riversLayerRef.current.bringToFront();
      if (aoiLayerRef.current)    aoiLayerRef.current.bringToFront();
    }
  }, [reliefOpacity]);

  // Helper: fetch watershed GeoJSON for the current map bounds
  const fetchWatershedLayer = useCallback(async (
    layerId: number,
    key: "l5" | "l6" | "l7",
    ref: React.MutableRefObject<L.GeoJSON | null>,
    color: string
  ) => {
    if (!leafletMap.current || wsLoadingRef.current[key]) return;
    wsLoadingRef.current[key] = true;
    try {
      const b = leafletMap.current.getBounds();
      const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const url = `https://wwf-sight-maps.org/arcgis/rest/services/Global/Hydrology/MapServer/${layerId}/query` +
        `?where=1%3D1&geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326` +
        `&spatialRel=esriSpatialRelIntersects&outFields=PFAF_ID%2CSUB_AREA&f=geojson&resultRecordCount=200`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!leafletMap.current) return;
      // Remove old layer
      if (ref.current) { leafletMap.current.removeLayer(ref.current); ref.current = null; }
      ref.current = L.geoJSON(data, {
        style: {
          color, weight: 1.5, fill: true,
          fillColor: color, fillOpacity: 0.08, opacity: 0.75, interactive: false,
        },
      }).addTo(leafletMap.current);
      // Keep AOI on top of watersheds
      if (aoiLayerRef.current)  aoiLayerRef.current.bringToFront();
    } catch (_) { /* ignore fetch errors */ } finally {
      wsLoadingRef.current[key] = false;
    }
  }, []);

  // Bind stable fetch functions for use in map moveend handler
  const fetchL5 = useCallback(() => fetchWatershedLayer(5, "l5", wsL5Ref, "#f97316"), [fetchWatershedLayer]);
  const fetchL6 = useCallback(() => fetchWatershedLayer(6, "l6", wsL6Ref, "#facc15"), [fetchWatershedLayer]);
  const fetchL7 = useCallback(() => fetchWatershedLayer(7, "l7", wsL7Ref, "#a3e635"), [fetchWatershedLayer]);
  useEffect(() => { fetchWsL5Ref.current = fetchL5; }, [fetchL5]);
  useEffect(() => { fetchWsL6Ref.current = fetchL6; }, [fetchL6]);
  useEffect(() => { fetchWsL7Ref.current = fetchL7; }, [fetchL7]);

  // Sync watershed overlays when toggled on/off
  useEffect(() => {
    if (!leafletMap.current) return;
    if (!wsL5On) {
      if (wsL5Ref.current) { leafletMap.current.removeLayer(wsL5Ref.current); wsL5Ref.current = null; }
    } else {
      fetchL5();
    }
  }, [wsL5On, fetchL5]);

  useEffect(() => {
    if (!leafletMap.current) return;
    if (!wsL6On) {
      if (wsL6Ref.current) { leafletMap.current.removeLayer(wsL6Ref.current); wsL6Ref.current = null; }
    } else {
      fetchL6();
    }
  }, [wsL6On, fetchL6]);

  useEffect(() => {
    if (!leafletMap.current) return;
    if (!wsL7On) {
      if (wsL7Ref.current) { leafletMap.current.removeLayer(wsL7Ref.current); wsL7Ref.current = null; }
    } else {
      fetchL7();
    }
  }, [wsL7On, fetchL7]);

  // Sync rivers/drainage overlay
  useEffect(() => {
    if (!leafletMap.current) return;
    if (!riversOn) {
      if (riversLayerRef.current) { leafletMap.current.removeLayer(riversLayerRef.current); riversLayerRef.current = null; }
    } else {
      if (!riversLayerRef.current) {
        riversLayerRef.current = L.tileLayer(
          "https://tiles.arcgis.com/tiles/iQ1dY19aHwbSDYIF/arcgis/rest/services/detailed_rivers/MapServer/tile/{z}/{y}/{x}",
          { opacity: 1.0, maxZoom: 19,
            attribution: 'Rivers &copy; <a href="https://www.esri.com/">Esri</a> | <a href="https://www.hydrosheds.org">HydroSHEDS</a>' }
        );
        riversLayerRef.current.addTo(leafletMap.current);
      }
      // Rivers sit above everything — bring to absolute front
      riversLayerRef.current!.bringToFront();
    }
  }, [riversOn]);

  // Update map cursor when geology overlay is toggled
  useEffect(() => {
    if (!leafletMap.current) return;
    const container = leafletMap.current.getContainer();
    if (geoOpacity > 0 && drawModeRef.current === "point") {
      container.style.cursor = "crosshair";
    } else if (drawModeRef.current !== "rect") {
      container.style.cursor = "";
    }
  }, [geoOpacity]);

  // Sync Macrostrat geology overlay opacity with slider
  useEffect(() => {
    if (!leafletMap.current) return;
    if (geoOpacity === 0) {
      if (macroLayerRef.current) {
        leafletMap.current.removeLayer(macroLayerRef.current);
        macroLayerRef.current = null;
      }
      if (geoPopupRef.current) {
        geoPopupRef.current.remove();
        geoPopupRef.current = null;
      }
    } else {
      if (!macroLayerRef.current) {
        macroLayerRef.current = L.tileLayer(
          "https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png",
          { opacity: geoOpacity / 100, maxZoom: 19, attribution: 'Geology © <a href="https://macrostrat.org">Macrostrat</a>' }
        );
        macroLayerRef.current.addTo(leafletMap.current);
        // Keep geology below rivers/AOI layers
        macroLayerRef.current.setZIndex(200);
        if (riversLayerRef.current) riversLayerRef.current.bringToFront();
        if (aoiLayerRef.current)    aoiLayerRef.current.bringToFront();
      } else {
        macroLayerRef.current.setOpacity(geoOpacity / 100);
      }
    }
  }, [geoOpacity]);

  useEffect(() => {
    if (leafletMap.current) setTimeout(() => leafletMap.current?.invalidateSize(), 50);
  }, [mapW, bodyH]);

  const cancelRect = useCallback(() => {
    corner1Ref.current = null;
    setRectStep(0);
    if (leafletMap.current) {
      if (rectPreviewRef.current) { leafletMap.current.removeLayer(rectPreviewRef.current); rectPreviewRef.current = null; }
      if (corner1MarkerRef.current) { leafletMap.current.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
    }
  }, []);

  const activatePointMode = useCallback(() => {
    cancelRect();
    setDrawMode("point");
    if (leafletMap.current) leafletMap.current.getContainer().style.cursor = "";
  }, [cancelRect]);

  const activateRectMode = useCallback(() => {
    cancelRect();
    setDrawMode("rect");
    setRectStep(0);
    if (leafletMap.current) leafletMap.current.getContainer().style.cursor = "crosshair";
  }, [cancelRect]);

  // Init Leaflet map once
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    const map = L.map(mapRef.current, { center: [20, 0], zoom: 2, zoomControl: true });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
      attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community',
      maxZoom: 19,
    }).addTo(map);

    const cyanIcon = L.divIcon({
      className: "",
      html: `<div style="width:14px;height:14px;border-radius:50%;background:#22d3ee;border:2px solid #fff;box-shadow:0 0 8px #22d3ee80"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });

    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (drawModeRef.current !== "rect" || rectStepRef.current !== 1 || !corner1Ref.current) return;
      const c1 = corner1Ref.current;
      const c2 = e.latlng;
      const bounds: L.LatLngBoundsExpression = [
        [Math.min(c1.lat, c2.lat), Math.min(c1.lng, c2.lng)],
        [Math.max(c1.lat, c2.lat), Math.max(c1.lng, c2.lng)],
      ];
      if (rectPreviewRef.current) {
        rectPreviewRef.current.setBounds(bounds);
      } else {
        rectPreviewRef.current = L.rectangle(bounds, {
          color: "#f59e0b", weight: 2, dashArray: "6 3",
          fill: true, fillColor: "#f59e0b", fillOpacity: 0.08, interactive: false,
        }).addTo(map);
      }
    });

    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;

      if (drawModeRef.current === "rect") {
        if (rectStepRef.current === 0) {
          corner1Ref.current = e.latlng;
          rectStepRef.current = 1;
          setRectStep(1);
          if (corner1MarkerRef.current) map.removeLayer(corner1MarkerRef.current);
          corner1MarkerRef.current = L.circleMarker([lat, lng], {
            radius: 5, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 1, weight: 2, interactive: false,
          }).addTo(map);
        } else {
          const c1 = corner1Ref.current!;
          const minLat = Math.min(c1.lat, lat);
          const maxLat = Math.max(c1.lat, lat);
          const minLon = Math.min(c1.lng, lng);
          const maxLon = Math.max(c1.lng, lng);

          if (rectPreviewRef.current) { map.removeLayer(rectPreviewRef.current); rectPreviewRef.current = null; }
          if (corner1MarkerRef.current) { map.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
          if (clickMarkerRef.current) { map.removeLayer(clickMarkerRef.current); clickMarkerRef.current = null; }

          // drawTiles() will redraw the AOI rect in blue

          corner1Ref.current = null;
          rectStepRef.current = 0;
          setRectStep(0);

          const label = `Region (${minLat.toFixed(1)}°–${maxLat.toFixed(1)}°N, ${minLon.toFixed(1)}°–${maxLon.toFixed(1)}°E)`;
          setLocationName(label);
          setPendingQuery({ type: "bbox", params: { minLat, maxLat, minLon, maxLon } });
        }
        return;
      }

      // When geology overlay is active: show geo popup only, skip GRACE/TC query
      if (geoOpacityRef.current > 0) {
        if (geoPopupRef.current) { geoPopupRef.current.remove(); geoPopupRef.current = null; }
        const loadingPopup = L.popup({ className: "geo-id-popup", offset: [0, -8], closeButton: true, autoClose: false, closeOnClick: false })
          .setLatLng([lat, lng])
          .setContent(`<div class="geo-popup-loading"><span class="geo-spinner"></span>Looking up geology…</div>`)
          .addTo(map);
        geoPopupRef.current = loadingPopup;
        fetch(`https://macrostrat.org/api/v2/geologic_units/map?lat=${lat}&lng=${lng}`)
          .then(r => r.json())
          .then(data => {
            if (!geoPopupRef.current || geoPopupRef.current !== loadingPopup) return;
            const unit = data?.success?.data?.[0];
            if (!unit) {
              loadingPopup.setContent(`<div class="geo-popup-body"><span style="color:#8b949e;font-size:11px">No geology data at this location</span></div>`);
              return;
            }
            const name    = unit.name || unit.strat_name || "Unknown unit";
            const ageName = unit.best_int_name || "";
            const ageRange = (unit.t_age != null && unit.b_age != null)
              ? `${Number(unit.t_age).toFixed(1)}–${Number(unit.b_age).toFixed(1)} Ma`
              : "";
            const age     = ageRange ? `${ageName ? ageName + ", " : ""}${ageRange}` : ageName;
            const lith    = unit.lith    || "";
            const descrip = unit.descrip || unit.comments || "";
            const color   = unit.color   || "#a78bfa";
            loadingPopup.setContent(`
              <div class="geo-popup-body">
                ${age  ? `<div class="geo-popup-row"><span class="geo-popup-label">Age</span>${age}</div>`      : ""}
                ${lith ? `<div class="geo-popup-row"><span class="geo-popup-label">Lithology</span>${lith}</div>` : ""}
              </div>`);
          })
          .catch(() => {
            if (geoPopupRef.current === loadingPopup)
              loadingPopup.setContent(`<div class="geo-popup-body"><span style="color:#f87171;font-size:11px">Geology lookup failed</span></div>`);
          });
        return; // ← stop here; don't fire GRACE/TC query
      }

      if (clickMarkerRef.current) map.removeLayer(clickMarkerRef.current);
      clickMarkerRef.current = L.marker([lat, lng], { icon: cyanIcon }).addTo(map);
      if (aoiLayerRef.current) aoiLayerRef.current.clearLayers();
      setLocationName(`Point (${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E)`);
      setPendingQuery({ type: "point", params: { lat, lon: lng } });
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawModeRef.current === "rect") {
        corner1Ref.current = null;
        rectStepRef.current = 0;
        setRectStep(0);
        if (rectPreviewRef.current) { map.removeLayer(rectPreviewRef.current); rectPreviewRef.current = null; }
        if (corner1MarkerRef.current) { map.removeLayer(corner1MarkerRef.current); corner1MarkerRef.current = null; }
      }
    };
    window.addEventListener("keydown", onKey);

    // Refresh active watershed layers on map move/zoom
    map.on("moveend", () => {
      if (wsL5OnRef.current) fetchWsL5Ref.current?.();
      if (wsL6OnRef.current) fetchWsL6Ref.current?.();
      if (wsL7OnRef.current) fetchWsL7Ref.current?.();
    });

    leafletMap.current = map;
    return () => { window.removeEventListener("keydown", onKey); map.remove(); leafletMap.current = null; };
  }, []);

  const handleSearch = useCallback(async () => {
    const q = searchText.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const result = await geocode(q);
      if (!result) { setSearchError("Location not found"); return; }
      const { lat, lon, displayName } = result;
      if (leafletMap.current) {
        leafletMap.current.setView([lat, lon], 6, { animate: true });
        const cyanIcon = L.divIcon({
          className: "",
          html: `<div style="width:14px;height:14px;border-radius:50%;background:#22d3ee;border:2px solid #fff;box-shadow:0 0 8px #22d3ee80"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        });
        if (clickMarkerRef.current) leafletMap.current.removeLayer(clickMarkerRef.current);
        clickMarkerRef.current = L.marker([lat, lon], { icon: cyanIcon }).addTo(leafletMap.current);
        cancelRect();
        setDrawMode("point");
        leafletMap.current.getContainer().style.cursor = "";
      }
      const shortName = displayName.split(",").slice(0, 2).join(",").trim();
      setLocationName(shortName);
      setPendingQuery({ type: "point", params: { lat, lon } });
    } catch {
      setSearchError("Search failed — check your connection");
    } finally {
      setSearchLoading(false);
    }
  }, [searchText, cancelRect]);

  // GRACE CSV download — matches currently selected chart mode (annual or monthly)
  const downloadCSV = useCallback(() => {
    if (!queryResult) return;
    const name = locationName || "Location";
    const isBbox = queryResult.bbox !== undefined;
    const locLine = isBbox
      ? [
          `# Bounding box: ${queryResult.bbox!.minLat.toFixed(3)}°–${queryResult.bbox!.maxLat.toFixed(3)}°N,  ${queryResult.bbox!.minLon.toFixed(3)}°–${queryResult.bbox!.maxLon.toFixed(3)}°E`,
          `# GRACE grid cells included: ${queryResult.nGridCells}  (0.5° resolution)`,
          `# Values are spatial mean across all included pixels`,
        ].join("\n")
      : `# GRACE grid centre: ${queryResult.lat!.toFixed(3)}°N  ${queryResult.lon!.toFixed(3)}°E  (0.5° pixel)`;

    const isMonthly = chartMode === "monthly";
    const dataRows = isMonthly
      ? queryResult.monthly
          .filter((d) => d.lwe !== null)
          .map((d) => `${d.date},${d.lwe !== null ? d.lwe!.toFixed(4) : ""}`)
      : queryResult.annual.map((d) => `${d.year},${d.lwe !== null ? d.lwe!.toFixed(4) : ""}`);

    const csv = [
      `# GRACE/GRACE-FO JPL Mascon RL06.3 CRI — Terrestrial Water Storage Anomaly`,
      `# Location: ${name}`,
      locLine,
      `# Units: cm LWE anomaly (relative to 2004–2009 baseline)`,
      `# Time resolution: ${isMonthly ? "monthly" : "annual mean"}`,
      `# Source: https://podaac.jpl.nasa.gov/GRACE`,
      ``,
      isMonthly ? `Month,LWE (cm)` : `Year,Mean LWE (cm)`,
      ...dataRows,
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `GRACE_LWE_${isMonthly ? "monthly" : "annual"}_${name.replace(/[^a-z0-9_\-]/gi, "_").replace(/_+/g, "_").slice(0, 36)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [queryResult, locationName, chartMode]);

  // GeoTIFF export — download zip of annual rasters for the current AOI
  // Must use the same API_BASE proxy prefix that apiRequest uses, otherwise
  // raw fetch() breaks on the deployed Perplexity static site.
  const API_BASE_TIFF = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
  const [tiffLoading, setTiffLoading] = useState(false);
  const downloadGeoTIFF = useCallback(async () => {
    if (!queryResult || tiffLoading) return;
    setTiffLoading(true);
    try {
      const isBbox = queryResult.bbox !== undefined;
      let path = "/api/export/geotiff";
      if (isBbox && queryResult.bbox) {
        const b = queryResult.bbox;
        path += `?minLat=${b.minLat}&maxLat=${b.maxLat}&minLon=${b.minLon}&maxLon=${b.maxLon}`;
      } else if (queryResult.lat !== undefined && queryResult.lon !== undefined) {
        // Single point — export just that one 0.5° tile
        const half = 0.25;
        path += `?minLat=${(queryResult.lat - half).toFixed(3)}&maxLat=${(queryResult.lat + half).toFixed(3)}&minLon=${(queryResult.lon - half).toFixed(3)}&maxLon=${(queryResult.lon + half).toFixed(3)}`;
      }
      const resp = await fetch(`${API_BASE_TIFF}${path}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        alert("GeoTIFF export failed: " + (err.error || resp.statusText));
        return;
      }
      const blob = await resp.blob();
      const a = document.createElement("a");
      const objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      // Derive filename from content-disposition or build one
      const cd = resp.headers.get("content-disposition") || "";
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const name = locationName || "Region";
      a.download = fnMatch ? fnMatch[1] : `GRACE_LWE_GeoTIFFs_${name.replace(/[^a-z0-9_\-]/gi, "_").slice(0, 30)}.zip`;
      a.click();
      URL.revokeObjectURL(objUrl);
    } catch (e: any) {
      alert("GeoTIFF export error: " + e.message);
    } finally {
      setTiffLoading(false);
    }
  }, [queryResult, locationName, tiffLoading, API_BASE_TIFF]);

  // TerraClimate CSV download — matches currently selected chart mode (annual or monthly full series)
  const downloadTCCSV = useCallback(() => {
    if (!tcResult) return;
    const name = locationName || "Location";
    const isBbox = tcResult.bbox !== undefined;
    const locLine = isBbox
      ? `# Bounding box: ${tcResult.bbox!.minLat.toFixed(3)}°–${tcResult.bbox!.maxLat.toFixed(3)}°N, ${tcResult.bbox!.minLon.toFixed(3)}°–${tcResult.bbox!.maxLon.toFixed(3)}°E`
      : `# Point: ${tcResult.lat!.toFixed(3)}°N, ${tcResult.lon!.toFixed(3)}°E`;

    const isMonthly = tcChartMode === "monthly_series";
    const isClimatology = tcChartMode === "monthly_mean";

    let dataRows: string[];
    let header: string;
    let resNote: string;

    if (isMonthly) {
      // Export full monthly time series (not just the 12-month average)
      const monthlyPpt = tcResult.variables.ppt.monthly;
      const monthlyAet = tcResult.variables.aet.monthly;
      const monthlyRo  = tcResult.variables.q.monthly;
      header  = `Month,Precip (mm),Actual ET (mm),Runoff (mm)`;
      resNote = `# Time resolution: monthly values (2002–2025 full series)`;
      dataRows = monthlyPpt.map((d, i) => {
        const p = d.value  !== null ? d.value!.toFixed(1)              : "";
        const a = monthlyAet[i]?.value !== null ? monthlyAet[i]?.value!.toFixed(1) : "";
        const r = monthlyRo[i]?.value  !== null ? monthlyRo[i]?.value!.toFixed(1)  : "";
        return `${d.month},${p},${a},${r}`;
      });
    } else if (isClimatology) {
      // Climatological mean by calendar month (Jan–Dec averages across 2002–2025)
      const mmPpt = tcResult.variables.ppt.monthly_means;
      const mmAet = tcResult.variables.aet.monthly_means;
      const mmRo  = tcResult.variables.q.monthly_means;
      header  = `Month,Precip (mm),Actual ET (mm),Runoff (mm),Baseflow (mm)`;
      resNote = `# Time resolution: climatological monthly mean (average across 2002–2025)`;
      dataRows = MONTH_LABELS.map((lbl, i) => {
        const p  = mmPpt[i] !== null ? mmPpt[i]!.toFixed(1) : "";
        const a  = mmAet[i] !== null ? mmAet[i]!.toFixed(1) : "";
        const r  = mmRo[i]  !== null ? mmRo[i]!.toFixed(1)  : "";
        const bf = baseflowMeans[i] !== null ? baseflowMeans[i]!.toFixed(1) : "";
        return `${lbl},${p},${a},${r},${bf}`;
      });
      // Append annual mean row (mean of 12 monthly means)
      const annMeanP  = mmPpt.every(v => v !== null) ? (mmPpt as number[]).reduce((a,b)=>a+b,0)/12 : null;
      const annMeanA  = mmAet.every(v => v !== null) ? (mmAet as number[]).reduce((a,b)=>a+b,0)/12 : null;
      const annMeanR  = mmRo.every(v  => v !== null) ? (mmRo  as number[]).reduce((a,b)=>a+b,0)/12 : null;
      const annMeanBf = baseflowMeans.every(v => v !== null) ? (baseflowMeans as number[]).reduce((a,b)=>a+b,0)/12 : null;
      dataRows.push(
        `Annual Mean,${annMeanP?.toFixed(1)??''},${annMeanA?.toFixed(1)??''},${annMeanR?.toFixed(1)??''},${annMeanBf?.toFixed(1)??''}`
      );
    } else {
      const annualPpt = tcResult.variables.ppt.annual;
      const annualAet = tcResult.variables.aet.annual;
      const annualRo  = tcResult.variables.q.annual;
      header  = `Year,Precip (mm),Actual ET (mm),Runoff (mm)`;
      resNote = `# Time resolution: annual totals (sum of 12 monthly values per year)`;
      dataRows = annualPpt.map((d, i) => {
        const p = d.value !== null ? d.value!.toFixed(1) : "";
        const a = annualAet[i]?.value !== null ? annualAet[i]?.value!.toFixed(1) : "";
        const r = annualRo[i]?.value  !== null ? annualRo[i]?.value!.toFixed(1)  : "";
        return `${d.year},${p},${a},${r}`;
      });
    }

    const csv = [
      `# TerraClimate — Climate Water Balance Variables`,
      `# Location: ${name}`,
      locLine,
      `# Units: mm`,
      resNote,
      `# Source: https://www.climatologylab.org/terraclimate.html`,
      `# Variables: ppt = precipitation, aet = actual evapotranspiration, q = runoff`,
      ``,
      header,
      ...dataRows,
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = isMonthly ? "monthly" : isClimatology ? "monthly_mean" : "annual";
    a.download = `TerraClimate_${suffix}_${name.replace(/[^a-z0-9_\-]/gi, "_").replace(/_+/g, "_").slice(0, 36)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [tcResult, locationName, tcChartMode]);

  // TerraClimate GeoTIFF download
  const API_BASE_TC_TIFF = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
  const [tcTiffLoading, setTcTiffLoading] = useState(false);
  const downloadTCGeoTIFF = useCallback(async () => {
    if (!tcResult || tcTiffLoading) return;
    setTcTiffLoading(true);
    try {
      let path = "/api/export/tc-geotiff";
      if (tcResult.bbox) {
        const b = tcResult.bbox;
        path += `?minLat=${b.minLat}&maxLat=${b.maxLat}&minLon=${b.minLon}&maxLon=${b.maxLon}`;
      } else {
        path += `?lat=${tcResult.lat}&lon=${tcResult.lon}`;
      }
      const resp = await fetch(`${API_BASE_TC_TIFF}${path}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        alert("TC GeoTIFF export failed: " + (err.error || resp.statusText));
        return;
      }
      const blob = await resp.blob();
      const a = document.createElement("a");
      const objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      const cd = resp.headers.get("content-disposition") || "";
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const name = locationName || "Location";
      a.download = fnMatch ? fnMatch[1] : `TerraClimate_GeoTIFFs_${name.replace(/[^a-z0-9_\-]/gi, "_").slice(0, 30)}.zip`;
      a.click();
      URL.revokeObjectURL(objUrl);
    } catch (e: any) {
      alert("TC GeoTIFF export error: " + e.message);
    } finally {
      setTcTiffLoading(false);
    }
  }, [tcResult, locationName, tcTiffLoading, API_BASE_TC_TIFF]);

  const chartData = queryResult
    ? chartMode === "annual"
      ? queryResult.annual.map((d) => ({ label: String(d.year), value: d.lwe }))
      : queryResult.monthly.filter((d) => d.lwe !== null).map((d) => ({ label: d.date || "", value: d.lwe }))
    : [];

  const maxAbs = chartData.reduce((m, d) => Math.max(m, Math.abs(d.value ?? 0)), 0);

  // barColor: exact same symmetric scale as raster
  // -absMax→blue(0,0,255)  0→white(255,255,255)  +absMax→red(255,0,0)
  const chartAbsMax = graceChartAbsMaxRef.current || maxAbs || 0.01;
  const barColor = (v: number | null): string => {
    if (v === null) return "#444";
    const s = Math.min(1, Math.abs(v) / chartAbsMax);
    if (v >= 0) {
      // positive → white→red
      const c = Math.round(255 * (1 - s));
      return `rgb(255,${c},${c})`;
    } else {
      // negative → white→blue
      const c = Math.round(255 * (1 - s));
      return `rgb(${c},${c},255)`;
    }
  };

  const isReady = status?.loaded;
  const isError = !!status?.loadError;
  const progress = status?.loadProgress ?? "initializing...";
  const isBboxResult = queryResult?.bbox !== undefined;

  // TerraClimate chart helpers
  function tcChartData(varKey: "ppt" | "aet" | "q") {
    if (!tcResult) return [];
    if (tcChartMode === "annual") {
      return tcResult.variables[varKey].annual.map((d) => ({ label: String(d.year), value: d.value }));
    } else if (tcChartMode === "monthly_series") {
      // Full monthly time series (2002-01 through 2025-12)
      return tcResult.variables[varKey].monthly
        .filter((d) => d.value !== null)
        .map((d) => ({ label: d.month, value: d.value }));
    } else {
      // Climatological monthly means: Jan avg, Feb avg … Dec avg across all years
      return tcResult.variables[varKey].monthly_means.map((v, i) => ({ label: MONTH_LABELS[i], value: v }));
    }
  }

  const TC_COLORS: Record<string, string> = { ppt: "#60a5fa", aet: "#34d399", q: "#a78bfa", bf: "#fb923c" };
  const TC_LABELS: Record<string, string> = { ppt: "Precip (mm)", aet: "Actual ET (mm)", q: "Runoff (mm)", bf: "Baseflow (mm)" };
  const TC_UNITS: Record<string, string> = { ppt: "mm", aet: "mm", q: "mm", bf: "mm" };

  // Baseflow = max(0, ppt - aet - q), computed from monthly_means only
  const baseflowMeans: (number | null)[] = (() => {
    if (!tcResult) return Array(12).fill(null);
    const mmP = tcResult.variables.ppt.monthly_means;
    const mmA = tcResult.variables.aet.monthly_means;
    const mmQ = tcResult.variables.q.monthly_means;
    return MONTH_LABELS.map((_, i) => {
      const p = mmP[i], a = mmA[i], q = mmQ[i];
      if (p === null || a === null || q === null) return null;
      return Math.max(0, p - a - q);
    });
  })();

  function TCBarChart({ varKey }: { varKey: "ppt" | "aet" | "q" | "bf" }) {
    const data = varKey === "bf"
      ? baseflowMeans.map((v, i) => ({ label: MONTH_LABELS[i], value: v }))
      : tcChartData(varKey as "ppt" | "aet" | "q");
    const color = TC_COLORS[varKey];
    return (
      <div style={{ height: 110, padding: "0 2px 0 0" }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 2, right: 6, left: -14, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false}/>
            <XAxis
              dataKey="label"
              tick={{ fill: "#6e7681", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#30363d" }}
              interval={tcChartMode === "annual" ? 3 : tcChartMode === "monthly_series" ? 23 : 0}
            />
            <YAxis
              tick={{ fill: "#6e7681", fontSize: 9, fontFamily: "monospace" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v.toFixed(0)}
              width={32}
            />
            <Tooltip
              contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 6, fontSize: 10, fontFamily: "monospace", color: "#e6edf3" }}
              cursor={{ fill: "#21262d" }}
              formatter={(val: number) => [`${val?.toFixed(1)} mm`, TC_LABELS[varKey]]}
            />
            <Bar dataKey="value" maxBarSize={tcChartMode === "annual" ? 16 : tcChartMode === "monthly_series" ? 6 : 18} radius={[2, 2, 0, 0]} fill={color} fillOpacity={0.85}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <>
      <style>{`
        html, body, #root {
          width: 100% !important; height: 100% !important;
          margin: 0 !important; padding: 0 !important;
          overflow: hidden !important;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        .leaflet-bar a {
          background-color: #161b22 !important;
          border-color: #30363d !important;
          color: #e6edf3 !important;
        }
        .leaflet-bar a:hover { background-color: #21262d !important; color: #22d3ee !important; }
        .leaflet-control-attribution {
          background: rgba(13,17,23,0.85) !important;
          color: #6e7681 !important; font-size: 10px !important;
        }
        .leaflet-control-attribution a { color: #22d3ee !important; }
        .search-input::placeholder { color: #8b949e; }
        .search-input:focus { outline: none; border-color: #22d3ee !important; }
        .tool-btn { transition: background 0.15s, border-color 0.15s, color 0.15s; }
        .mode-btn-point {
          display: flex; align-items: center; gap: 6px;
          padding: 5px 14px; font-size: 12px; font-weight: 700;
          border-radius: 6px; cursor: pointer; transition: all 0.15s;
          letter-spacing: 0.02em;
        }
        .mode-btn-rect {
          display: flex; align-items: center; gap: 6px;
          padding: 5px 14px; font-size: 12px; font-weight: 700;
          border-radius: 6px; cursor: pointer; transition: all 0.15s;
          letter-spacing: 0.02em;
        }
        /* ── Geology ID popup ── */
        .geo-id-popup .leaflet-popup-content-wrapper {
          background: #161b22;
          border: 1px solid #a78bfa60;
          border-radius: 8px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.6);
          padding: 0;
          min-width: 220px;
          max-width: 300px;
        }
        .geo-id-popup .leaflet-popup-content { margin: 0; }
        .geo-id-popup .leaflet-popup-tip-container .leaflet-popup-tip { background: #161b22; }
        .geo-id-popup .leaflet-popup-close-button {
          color: #6e7681 !important; font-size: 16px !important;
          top: 6px !important; right: 8px !important;
        }
        .geo-id-popup .leaflet-popup-close-button:hover { color: #e6edf3 !important; }
        .geo-popup-loading {
          display: flex; align-items: center; gap: 8px;
          padding: 12px 14px; font-size: 11px; color: #8b949e;
        }
        .geo-spinner {
          display: inline-block; width: 12px; height: 12px; border-radius: 50%;
          border: 2px solid #30363d; border-top-color: #a78bfa;
          animation: spin 0.8s linear infinite; flex-shrink: 0;
        }
        .geo-popup-body { padding: 12px 14px 10px; }
        .geo-popup-swatch {
          width: 100%; height: 6px; border-radius: 3px;
          margin-bottom: 8px; opacity: 0.85;
        }
        .geo-popup-name {
          font-size: 12px; font-weight: 700; color: #e6edf3;
          margin-bottom: 6px; line-height: 1.3;
        }
        .geo-popup-row {
          display: flex; align-items: baseline; gap: 6px;
          font-size: 11px; color: #c9d1d9; margin-bottom: 3px; line-height: 1.4;
        }
        .geo-popup-label {
          font-size: 10px; font-weight: 700; color: #8b949e;
          text-transform: uppercase; letter-spacing: 0.07em;
          flex-shrink: 0; min-width: 54px;
        }
        .geo-popup-desc {
          margin-top: 6px; font-size: 11px; color: #8b949e;
          line-height: 1.5; border-top: 1px solid #21262d; padding-top: 6px;
        }
      `}</style>

      <div ref={rootRef} style={{ position: "fixed", top: 0, left: 0, width: size.w, height: size.h, background: "#0d1117", overflow: "hidden" }}>

        {/* ── HEADER ── */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: HDR_H,
          display: "flex", alignItems: "center", gap: 10,
          padding: "0 16px", background: "#161b22", borderBottom: "1px solid #30363d", zIndex: 10,
        }}>
          {/* Logo + title */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
            <svg viewBox="0 0 36 36" width="26" height="26" fill="none">
              <circle cx="18" cy="18" r="16" stroke="#22d3ee" strokeWidth="1.5"/>
              <circle cx="18" cy="18" r="9" stroke="#22d3ee" strokeWidth="1" strokeDasharray="3 2"/>
              <ellipse cx="18" cy="18" rx="16" ry="6" stroke="#5b9bd5" strokeWidth="1"/>
              <circle cx="18" cy="18" r="2.5" fill="#22d3ee"/>
            </svg>
            <div>
              <div style={{ fontWeight: 700, fontSize: "13px", color: "#e6edf3", lineHeight: 1.2 }}>GRACE-TC-Geology Explorer</div>
              <div style={{ fontSize: "10px", color: "#8b949e", fontFamily: "monospace", lineHeight: 1.2 }}>JPL Mascon RL06.3 + TerraClimate</div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 30, background: "#30363d", flexShrink: 0 }}/>

          {/* GEOLOGY OVERLAY SLIDER */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" style={{ flexShrink: 0 }}>
              <path d="M1 11L4.5 5.5l2.5 3 1.8-2.5L12 11H1z" stroke="#a78bfa" strokeWidth="1.3" strokeLinejoin="round"/>
              <circle cx="10" cy="3.5" r="1.5" stroke="#a78bfa" strokeWidth="1.3"/>
            </svg>
            <span style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Geology</span>
            <input
              type="range" min={0} max={100} step={5} value={geoOpacity}
              onChange={(e) => setGeoOpacity(Number(e.target.value))}
              title={`Geology overlay opacity: ${geoOpacity}%`}
              style={{ width: 80, accentColor: "#a78bfa", cursor: "pointer" }}
            />
            <span style={{ fontSize: "10px", color: geoOpacity > 0 ? "#a78bfa" : "#484f58", fontFamily: "monospace", width: 28, textAlign: "right" }}>
              {geoOpacity > 0 ? `${geoOpacity}%` : "off"}
            </span>
          </div>

          {/* RELIEF OVERLAY SLIDER */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" style={{ flexShrink: 0 }}>
              <path d="M1 12 L4 6 L7 9 L10 4 L13 8" stroke="#34d399" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
              <path d="M1 12 L4 6 L7 9 L10 4 L13 8 L13 12 Z" fill="#34d399" fillOpacity="0.15"/>
            </svg>
            <span style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Relief</span>
            <input
              type="range" min={0} max={100} step={5} value={reliefOpacity}
              onChange={(e) => setReliefOpacity(Number(e.target.value))}
              title={`Color relief opacity: ${reliefOpacity}%`}
              style={{ width: 80, accentColor: "#34d399", cursor: "pointer" }}
            />
            <span style={{ fontSize: "10px", color: reliefOpacity > 0 ? "#34d399" : "#484f58", fontFamily: "monospace", width: 28, textAlign: "right" }}>
              {reliefOpacity > 0 ? `${reliefOpacity}%` : "off"}
            </span>
          </div>

          {/* GRACE RASTER OVERLAY CONTROLS */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
            {/* GRACE satellite icon */}
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" style={{ flexShrink: 0 }}>
              <circle cx="7" cy="7" r="5.5" stroke="#f59e0b" strokeWidth="1.3"/>
              <circle cx="7" cy="7" r="2" fill="#f59e0b" fillOpacity="0.6"/>
              <line x1="7" y1="1" x2="7" y2="3" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="7" y1="11" x2="7" y2="13" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="1" y1="7" x2="3" y2="7" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="11" y1="7" x2="13" y2="7" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>GRACE</span>
            {/* Year selector */}
            <select
              value={graceRasterYear}
              onChange={(e) => setGraceRasterYear(Number(e.target.value))}
              title="GRACE LWE overlay year"
              style={{
                height: 26, padding: "0 4px", fontSize: "11px", fontFamily: "monospace",
                background: "#0d1117", border: "1px solid #f59e0b60", borderRadius: 4,
                color: "#f59e0b", cursor: "pointer", outline: "none",
              }}
            >
              {Array.from({ length: 2026 - 2002 + 1 }, (_, i) => 2002 + i).map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            {/* Opacity/saturation slider */}
            <input
              type="range" min={0} max={100} step={5}
              value={Math.round(graceRasterOpacity * 100)}
              onChange={(e) => setGraceRasterOpacity(Number(e.target.value) / 100)}
              title={`GRACE raster opacity: ${Math.round(graceRasterOpacity * 100)}%`}
              style={{ width: 72, accentColor: "#f59e0b", cursor: "pointer" }}
            />
            <span style={{ fontSize: "10px", color: graceRasterOpacity > 0 ? "#f59e0b" : "#484f58", fontFamily: "monospace", width: 28, textAlign: "right" }}>
              {graceRasterOpacity > 0 ? `${Math.round(graceRasterOpacity * 100)}%` : "off"}
            </span>
            {/* Diverging color legend — shares the bar-chart scale once an AOI is selected */}
            <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, marginLeft: 2 }}>
              {/* Left label: lo (full blue extreme) */}
              <span style={{ fontSize: "8px", color: "#60a5fa", fontFamily: "monospace", lineHeight: 1, textAlign: "right", minWidth: 30 }}>
                {graceLegendRange ? (graceLegendRange.lo < 0 ? `−${Math.abs(graceLegendRange.lo).toFixed(1)}` : graceLegendRange.lo.toFixed(1)) : "−"}
              </span>
              {/* Gradient bar with tick at center (= 0) */}
              <div style={{ position: "relative", flexShrink: 0 }}>
                <div style={{
                  width: 52, height: 10, borderRadius: 3,
                  background: "linear-gradient(to right, rgb(0,100,220), rgb(255,255,255), rgb(220,40,40))",
                  border: `1px solid ${graceLegendRange ? "#f59e0b80" : "#30363d"}`,
                  boxShadow: graceLegendRange ? "0 0 4px #f59e0b40" : "none",
                }}/>
                {/* Centre tick = 0 LWE */}
                <div style={{
                  position: "absolute", top: -2, left: "calc(50% - 0.5px)",
                  width: 1, height: 14, background: "#ffffff80", pointerEvents: "none",
                }}/>
              </div>
              {/* Right label: hi (full red extreme) */}
              <span style={{ fontSize: "8px", color: "#f87171", fontFamily: "monospace", lineHeight: 1, minWidth: 30 }}>
                {graceLegendRange ? `+${graceLegendRange.hi.toFixed(1)}` : "+"}
              </span>
              {graceLegendRange && (
                <span style={{ fontSize: "7px", color: "#f59e0b", fontFamily: "monospace", lineHeight: 1 }}>cm</span>
              )}
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 30, background: "#30363d", flexShrink: 0 }}/>

          {/* MAP MODE SELECTOR — prominent */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, flexShrink: 0 }}>Map Mode:</span>
            <button
              className="mode-btn-point"
              onClick={activatePointMode}
              title="Click a single point on the map"
              style={{
                border: drawMode === "point" ? "2px solid #22d3ee" : "2px solid #30363d",
                background: drawMode === "point" ? "#0e4c5a" : "#0d1117",
                color: drawMode === "point" ? "#22d3ee" : "#6e7681",
                boxShadow: drawMode === "point" ? "0 0 0 2px #22d3ee22" : "none",
              }}
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none">
                <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.8"/>
                <circle cx="7" cy="7" r="1.8" fill="currentColor"/>
              </svg>
              Point
            </button>
            <button
              className="mode-btn-rect"
              onClick={activateRectMode}
              title="Click two corners to define a region"
              style={{
                border: drawMode === "rect" ? "2px solid #f59e0b" : "2px solid #30363d",
                background: drawMode === "rect" ? "#3a2800" : "#0d1117",
                color: drawMode === "rect" ? "#f59e0b" : "#6e7681",
                boxShadow: drawMode === "rect" ? "0 0 0 2px #f59e0b22" : "none",
              }}
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none">
                <rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.8"/>
                <circle cx="2" cy="3" r="1.8" fill="currentColor"/>
                <circle cx="12" cy="11" r="1.8" fill="currentColor"/>
              </svg>
              Region
            </button>
          </div>

          {/* Step hint for rect mode */}
          {drawMode === "rect" && (
            <div style={{
              fontSize: 11, fontFamily: "monospace",
              color: rectStep === 0 ? "#f59e0b" : "#fcd34d",
              background: "#1a1200", border: `1px solid ${rectStep === 0 ? "#f59e0b60" : "#f59e0b"}`,
              borderRadius: 5, padding: "4px 10px", flexShrink: 0,
            }}>
              {rectStep === 0 ? "▶ Click corner #1 on map" : "▶ Click corner #2 on map  ·  Esc to cancel"}
            </div>
          )}

          {/* Search */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" style={{ position: "absolute", left: 9, pointerEvents: "none" }}>
                <circle cx="6.5" cy="6.5" r="4.5" stroke="#8b949e" strokeWidth="1.4"/>
                <path d="M10 10l3 3" stroke="#8b949e" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
              <input
                className="search-input"
                type="text"
                placeholder="Search city or country…"
                value={searchText}
                onChange={(e) => { setSearchText(e.target.value); setSearchError(null); }}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                style={{
                  paddingLeft: 28, paddingRight: 10, height: 30, width: 200,
                  background: "#0d1117", border: "1px solid #30363d",
                  borderRadius: 6, fontSize: 12, color: "#e6edf3",
                }}
              />
            </div>
            <button onClick={handleSearch} disabled={searchLoading || !searchText.trim()} style={{
              height: 30, padding: "0 12px", fontSize: 12, fontWeight: 600,
              background: "#0e4c5a", border: "1px solid #22d3ee", borderRadius: 6,
              color: "#22d3ee", cursor: searchLoading || !searchText.trim() ? "not-allowed" : "pointer",
              opacity: searchLoading || !searchText.trim() ? 0.5 : 1,
            }}>
              {searchLoading ? "…" : "Go"}
            </button>
            {searchError && <span style={{ fontSize: 11, color: "#f87171" }}>{searchError}</span>}
          </div>

          {/* Status */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <div style={{
              width: "8px", height: "8px", borderRadius: "50%",
              background: isError ? "#f85149" : isReady ? "#3fb950" : "#d29922",
              animation: isReady || isError ? "none" : "pulse 1.5s infinite",
            }}/>
            <span style={{ fontSize: "11px", color: "#8b949e", fontFamily: "monospace" }}>
              {isError ? "Error" : isReady ? `GRACE: ${status!.nTimes}mo` : progress}
            </span>
          </div>
        </div>

        {/* ── LEFT PANEL: TERRACLIMATE ── */}
        <div style={{
          position: "absolute", top: HDR_H, left: 0, width: TC_PANEL_W, height: bodyH,
          display: "flex", flexDirection: "column",
          overflowY: "auto", background: "#0d1117", borderRight: "1px solid #30363d",
        }}>
          {/* TC Panel Header */}
          <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid #30363d", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                <path d="M8 2C4.13 2 1 5.13 1 9s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7z" stroke="#60a5fa" strokeWidth="1.3"/>
                <path d="M5 9c0-1.66 1.34-3 3-3s3 1.34 3 3" stroke="#34d399" strokeWidth="1.3" strokeLinecap="round"/>
                <path d="M3 11c1.5 1.5 3 2 5 2s3.5-.5 5-2" stroke="#a78bfa" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <span style={{ fontWeight: 700, fontSize: "11px", color: "#e6edf3", textTransform: "uppercase", letterSpacing: "0.07em" }}>TerraClimate</span>
            </div>
            <div style={{ fontSize: "10px", color: "#6e7681", lineHeight: 1.5 }}>
              Monthly climate water balance · 2002–2025
            </div>
          </div>

          {/* Empty state / Calculate button */}
          {!tcResult && !tcLoading && !tcError && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "20px 16px", textAlign: "center" }}>
              <svg viewBox="0 0 64 64" width="40" height="40" fill="none" style={{ opacity: 0.15, marginBottom: 12 }}>
                <path d="M32 8C18 8 8 18 8 32s10 24 24 24 24-10 24-24S46 8 32 8z" stroke="#e6edf3" strokeWidth="2"/>
                <path d="M20 34c0-6.63 5.37-12 12-12s12 5.37 12 12" stroke="#e6edf3" strokeWidth="2" strokeLinecap="round"/>
                <path d="M12 42c5 5 10 8 20 8s15-3 20-8" stroke="#e6edf3" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {pendingQuery ? (
                <>
                  <div style={{ fontSize: "11px", color: "#8b949e", lineHeight: 1.8, marginBottom: 14 }}>
                    AOI selected — ready to fetch climate data
                  </div>
                  <button
                    onClick={() => runTCQuery(pendingQuery!)}
                    style={{
                      padding: "8px 18px", fontSize: "12px", fontWeight: 700,
                      background: "#0c2340", border: "1.5px solid #60a5fa",
                      borderRadius: 7, color: "#60a5fa", cursor: "pointer",
                      letterSpacing: "0.03em",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#1a3a5c"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#0c2340"; }}
                  >
                    Calculate TC Data
                  </button>
                </>
              ) : (
                <div style={{ fontSize: "11px", color: "#6e7681", lineHeight: 1.8 }}>
                  {isReady
                    ? <>Select a <span style={{ color: "#22d3ee" }}>point</span> or <span style={{ color: "#f59e0b" }}>region</span> on the map,<br/>then click <strong style={{ color: "#60a5fa" }}>Calculate TC Data</strong><br/><span style={{ fontSize: "10px", color: "#484f58", marginTop: 4, display: "block" }}>Precip · Actual ET · Runoff · Baseflow</span></>
                    : "Loading…"}
                </div>
              )}
            </div>
          )}

          {/* TC Loading */}
          {tcLoading && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid #30363d", borderTopColor: "#60a5fa", animation: "spin 0.8s linear infinite", marginBottom: 10 }}/>
              <div style={{ fontSize: "11px", color: "#8b949e", textAlign: "center", lineHeight: 1.6 }}>
                Fetching TerraClimate data<br/>
                <span style={{ fontSize: "10px", color: "#484f58" }}>Querying THREDDS server…</span>
              </div>
            </div>
          )}

          {/* TC Error */}
          {tcError && !tcLoading && (
            <div style={{ padding: 12 }}>
              <div style={{ background: "#1a0e0e", border: "1px solid #5a1a1a", borderRadius: 8, padding: 10, fontSize: 11, color: "#f87171" }}>{tcError}</div>
            </div>
          )}

          {/* TC Results */}
          {tcResult && !tcLoading && (
            <>
              {/* Location label + recalculate */}
              <div style={{ padding: "6px 12px", borderBottom: "1px solid #21262d", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: "10px", color: "#8b949e" }}>{locationName}</div>
                {pendingQuery && (
                  <button
                    onClick={() => runTCQuery(pendingQuery!)}
                    title="Re-fetch TC data for current AOI"
                    style={{
                      padding: "2px 8px", fontSize: "9px", fontWeight: 600,
                      background: "transparent", border: "1px solid #30363d",
                      borderRadius: 4, color: "#484f58", cursor: "pointer",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#60a5fa"; (e.currentTarget as HTMLButtonElement).style.color = "#60a5fa"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#30363d"; (e.currentTarget as HTMLButtonElement).style.color = "#484f58"; }}
                  >
                    Recalculate
                  </button>
                )}
              </div>

              {/* Mode toggle + CSV + GeoTIFF */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: "1px solid #21262d", flexShrink: 0 }}>
                <div style={{ display: "flex", background: "#161b22", border: "1px solid #30363d", borderRadius: 5, overflow: "hidden" }}>
                  {(["annual", "monthly_series", "monthly_mean"] as const).map((m) => (
                    <button key={m} onClick={() => setTcChartMode(m)} style={{
                      padding: "2px 8px", fontSize: "10px", border: "none", cursor: "pointer",
                      fontWeight: tcChartMode === m ? 600 : 400,
                      background: tcChartMode === m ? "#0c2340" : "transparent",
                      color: tcChartMode === m ? "#60a5fa" : "#8b949e",
                    }}>
                      {m === "annual" ? "Annual" : m === "monthly_series" ? "Monthly" : "Mo. Mean"}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                  {/* CSV */}
                  <button
                    onClick={downloadTCCSV}
                    title="Download CSV"
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "2px 8px", fontSize: "10px", fontWeight: 600,
                      background: "#0d1117", border: "1px solid #30363d",
                      borderRadius: 5, color: "#8b949e", cursor: "pointer",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#60a5fa"; (e.currentTarget as HTMLButtonElement).style.color = "#60a5fa"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#30363d"; (e.currentTarget as HTMLButtonElement).style.color = "#8b949e"; }}
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none">
                      <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    CSV
                  </button>
                  {/* GeoTIFF */}
                  <button
                    onClick={downloadTCGeoTIFF}
                    disabled={tcTiffLoading}
                    title="Download GeoTIFFs (zip) — annual totals + monthly climatology — ppt, aet, q"
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "2px 8px", fontSize: "10px", fontWeight: 600,
                      background: tcTiffLoading ? "#0e2a1a" : "#0d1117",
                      border: `1px solid ${tcTiffLoading ? "#22c55e" : "#30363d"}`,
                      borderRadius: 5,
                      color: tcTiffLoading ? "#22c55e" : "#8b949e",
                      cursor: tcTiffLoading ? "wait" : "pointer",
                    }}
                    onMouseEnter={(e) => { if (!tcTiffLoading) { (e.currentTarget as HTMLButtonElement).style.borderColor = "#22c55e"; (e.currentTarget as HTMLButtonElement).style.color = "#22c55e"; } }}
                    onMouseLeave={(e) => { if (!tcTiffLoading) { (e.currentTarget as HTMLButtonElement).style.borderColor = "#30363d"; (e.currentTarget as HTMLButtonElement).style.color = "#8b949e"; } }}
                  >
                    {tcTiffLoading ? (
                      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                        <circle cx="8" cy="8" r="6" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="20 10" strokeLinecap="round"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="11" height="11" fill="none">
                        <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                        <path d="M5 8h6M8 5v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                      </svg>
                    )}
                    {tcTiffLoading ? "Building…" : "GeoTIFF"}
                  </button>
                </div>
              </div>

              {/* 3 base charts (all modes) */}
              {(["ppt", "aet", "q"] as const).map((varKey) => {
                const varData = tcResult.variables[varKey];
                const annualVals = varData.annual.map((d) => d.value).filter((v): v is number => v !== null);
                const total = annualVals.reduce((a, b) => a + b, 0);
                const avg = annualVals.length > 0 ? total / annualVals.length : 0;
                return (
                  <div key={varKey} style={{ borderBottom: "1px solid #21262d", padding: "8px 10px 4px", flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: TC_COLORS[varKey] }}/>
                        <span style={{ fontSize: "10px", fontWeight: 700, color: TC_COLORS[varKey], textTransform: "uppercase", letterSpacing: "0.07em" }}>
                          {varKey === "ppt" ? "Precipitation" : varKey === "aet" ? "Actual ET" : "Runoff"}
                        </span>
                      </div>
                      <span style={{ fontSize: "10px", fontFamily: "monospace", color: "#8b949e" }}>
                        avg {avg.toFixed(0)} mm/yr
                      </span>
                    </div>
                    <TCBarChart varKey={varKey} />
                  </div>
                );
              })}

              {/* Baseflow chart — Mo. Mean mode only */}
              {tcChartMode === "monthly_mean" && (() => {
                const bfAvg = baseflowMeans.filter((v): v is number => v !== null);
                const bfMean = bfAvg.length > 0 ? bfAvg.reduce((a, b) => a + b, 0) / bfAvg.length : 0;
                return (
                  <div style={{ borderBottom: "1px solid #21262d", padding: "8px 10px 4px", flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: TC_COLORS.bf }}/>
                        <span style={{ fontSize: "10px", fontWeight: 700, color: TC_COLORS.bf, textTransform: "uppercase", letterSpacing: "0.07em" }}>Baseflow</span>
                        <span style={{ fontSize: "9px", color: "#484f58", fontStyle: "italic" }}>P − AET − Q ≥ 0</span>
                      </div>
                      <span style={{ fontSize: "10px", fontFamily: "monospace", color: "#8b949e" }}>
                        avg {bfMean.toFixed(0)} mm/mo
                      </span>
                    </div>
                    <TCBarChart varKey="bf" />
                  </div>
                );
              })()}

              <div style={{ padding: "6px 12px", fontSize: 9, color: "#484f58", lineHeight: 1.5 }}>
                TerraClimate · ~4km res · THREDDS OPeNDAP<br/>
                <a href="https://www.climatologylab.org/terraclimate.html" target="_blank" rel="noopener noreferrer" style={{ color: "#484f58" }}>climatologylab.org</a>
              </div>
            </>
          )}

          <div style={{ marginTop: "auto", padding: "6px 12px", borderTop: "1px solid #30363d" }}>
            <div style={{ fontSize: "9px", color: "#484f58", marginBottom: 3 }}>Designed by Ken Hardcastle, 2026</div>
            <PerplexityAttribution />
          </div>
        </div>

        {/* ── MAP ── */}
        <div style={{ position: "absolute", top: HDR_H, left: TC_PANEL_W, width: mapW, height: bodyH, overflow: "hidden" }}>
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} data-testid="map-container"/>

          {/* ── FLOATING HYDROLOGY PANEL (bottom-left of map) ── */}
          <div style={{
            position: "absolute", bottom: 28, left: 10, zIndex: 500,
            background: "rgba(22,27,34,0.93)", border: "1px solid #30363d",
            borderRadius: 8, padding: "8px 10px", minWidth: 148,
            boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
            backdropFilter: "blur(4px)",
          }}>
            {/* Section label */}
            <div style={{ fontSize: "9px", color: "#484f58", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>Hydrology</div>

            {/* Rivers row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <svg viewBox="0 0 12 12" width="11" height="11" fill="none">
                  <path d="M1 3 Q3 1 5 3 Q7 5 9 3 Q11 1 12 3" stroke="#38bdf8" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
                  <path d="M1 7 Q3 5 5 7 Q7 9 9 7 Q11 5 12 7" stroke="#38bdf8" strokeWidth="1.0" fill="none" strokeLinecap="round" strokeOpacity="0.65"/>
                </svg>
                <span style={{ fontSize: "10px", color: "#c9d1d9", fontWeight: 500 }}>Rivers</span>
              </div>
              <button
                onClick={() => setRiversOn(v => !v)}
                title={riversOn ? "Hide HydroRIVERS drainage" : "Show HydroRIVERS detailed drainage"}
                style={{
                  width: 32, height: 16, borderRadius: 8, border: "none", cursor: "pointer",
                  position: "relative", background: riversOn ? "#0ea5e9" : "#30363d",
                  transition: "background 0.2s", flexShrink: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: 2, left: riversOn ? 16 : 2,
                  width: 12, height: 12, borderRadius: "50%", background: "#fff",
                  transition: "left 0.2s", display: "block",
                }}/>
              </button>
            </div>

            {/* Divider */}
            <div style={{ borderTop: "1px solid #21262d", marginBottom: 6 }}/>

            {/* Watershed label */}
            <div style={{ fontSize: "9px", color: "#484f58", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, marginBottom: 5 }}>Watersheds</div>

            {/* Watershed level buttons — stacked rows of 3 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {/* Row: description labels */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 3 }}>
                {([
                  { label: "L3", on: wsL5On, toggle: () => setWsL5On(v => !v), color: "#f97316", title: "Pfafstetter Level 3 — large basins (~300 globally)" },
                  { label: "L4", on: wsL6On, toggle: () => setWsL6On(v => !v), color: "#facc15", title: "Pfafstetter Level 4 — medium basins (~1,300 globally)" },
                  { label: "L5", on: wsL7On, toggle: () => setWsL7On(v => !v), color: "#a3e635", title: "Pfafstetter Level 5 — fine sub-basins (~4,700 globally)" },
                ]).map(({ label, on, toggle, color, title }) => (
                  <button
                    key={label}
                    onClick={toggle}
                    title={title}
                    style={{
                      padding: "3px 0", fontSize: "10px", fontWeight: on ? 700 : 400,
                      borderRadius: 4, border: `1px solid ${on ? color : "#30363d"}`,
                      background: on ? `${color}22` : "transparent",
                      color: on ? color : "#6e7681",
                      cursor: "pointer", transition: "all 0.15s", textAlign: "center",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* Size hint */}
              <div style={{ fontSize: "9px", color: "#484f58", lineHeight: 1.4, textAlign: "center" }}>
                L3 = large · L4 = medium · L5 = fine
              </div>
            </div>
          </div>

          {!isReady && !isError && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(13,17,23,0.78)", zIndex: 2000 }}>
              <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: "12px", padding: "28px 36px", textAlign: "center" }}>
                <div style={{ width: 40, height: 40, borderRadius: "50%", border: "3px solid #30363d", borderTopColor: "#22d3ee", animation: "spin 1s linear infinite", margin: "0 auto 12px" }}/>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#e6edf3", marginBottom: "4px" }}>Loading GRACE Data</div>
                <div style={{ fontSize: "11px", color: "#22d3ee", fontFamily: "monospace" }}>{progress}</div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL: GRACE ── */}
        <div style={{
          position: "absolute", top: HDR_H, right: 0, width: GRACE_PANEL_W, height: bodyH,
          display: "flex", flexDirection: "column",
          overflowY: "auto", background: "#161b22", borderLeft: "1px solid #30363d",
        }}>

          {!queryResult && !queryLoading && !queryError && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "28px 24px", textAlign: "center" }}>
              <svg viewBox="0 0 64 64" width="44" height="44" fill="none" style={{ opacity: 0.18, marginBottom: 14 }}>
                <circle cx="32" cy="32" r="28" stroke="#e6edf3" strokeWidth="2"/>
                <circle cx="32" cy="32" r="14" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 3"/>
                <circle cx="32" cy="32" r="4" fill="#22d3ee" opacity="0.6"/>
              </svg>
              <div style={{ fontSize: "12px", color: "#8b949e", lineHeight: 2.0, marginBottom: 16 }}>
                {isReady ? (
                  <>
                    <div style={{ marginBottom: 8, fontWeight: 600, color: "#e6edf3" }}>How to use:</div>
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ display: "inline-block", background: "#0e4c5a", border: "1.5px solid #22d3ee", color: "#22d3ee", borderRadius: 5, padding: "1px 8px", fontSize: 11, fontWeight: 700, marginRight: 4 }}>Point</span>
                      click anywhere on the map
                    </div>
                    <div>
                      <span style={{ display: "inline-block", background: "#3a2800", border: "1.5px solid #f59e0b", color: "#f59e0b", borderRadius: 5, padding: "1px 8px", fontSize: 11, fontWeight: 700, marginRight: 4 }}>Region</span>
                      click two corners of an area
                    </div>
                    <div style={{ marginTop: 14, fontSize: 10, color: "#484f58", lineHeight: 1.7 }}>
                      Both modes return GRACE LWE anomaly data<br/>
                      and TerraClimate climate variables<br/>
                      for the same location.
                    </div>
                  </>
                ) : "Loading data…"}
              </div>
            </div>
          )}

          {queryLoading && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2px solid #30363d", borderTopColor: "#22d3ee", animation: "spin 0.8s linear infinite", margin: "0 auto 8px" }}/>
                <div style={{ fontSize: "12px", color: "#8b949e" }}>Querying…</div>
              </div>
            </div>
          )}

          {queryError && !queryLoading && (
            <div style={{ padding: 16 }}>
              <div style={{ background: "#1a0e0e", border: "1px solid #5a1a1a", borderRadius: 8, padding: 12, fontSize: 12, color: "#f87171" }}>{queryError}</div>
            </div>
          )}

          {queryResult && !queryLoading && (() => {
            const vals = queryResult.annual.map((d) => d.lwe).filter((v): v is number => v !== null);
            const mn = Math.min(...vals), mx = Math.max(...vals);
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            return (
              <>
                {/* Toggle + CSV + GeoTIFF */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderBottom: "1px solid #30363d" }}>
                  <div style={{ display: "flex", background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, overflow: "hidden" }}>
                    {(["annual", "monthly"] as ChartMode[]).map((m) => (
                      <button key={m} onClick={() => setChartMode(m)} style={{
                        padding: "3px 12px", fontSize: "11px", border: "none", cursor: "pointer",
                        fontWeight: chartMode === m ? 600 : 400,
                        background: chartMode === m ? "#0e4c5a" : "transparent",
                        color: chartMode === m ? "#22d3ee" : "#8b949e",
                      }}>
                        {m === "annual" ? "Annual" : "Monthly"}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {/* CSV download */}
                    <button
                      onClick={downloadCSV}
                      title="Download CSV"
                      style={{
                        display: "flex", alignItems: "center", gap: 5,
                        padding: "3px 10px", fontSize: "11px", fontWeight: 600,
                        background: "#0d1117", border: "1px solid #30363d",
                        borderRadius: 6, color: "#8b949e", cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#22d3ee"; (e.currentTarget as HTMLButtonElement).style.color = "#22d3ee"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#30363d"; (e.currentTarget as HTMLButtonElement).style.color = "#8b949e"; }}
                    >
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                        <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      CSV
                    </button>
                    {/* GeoTIFF zip download */}
                    <button
                      onClick={downloadGeoTIFF}
                      disabled={tiffLoading}
                      title="Download annual GeoTIFFs (zip) — one raster per year, WGS84, LZW compressed"
                      style={{
                        display: "flex", alignItems: "center", gap: 5,
                        padding: "3px 10px", fontSize: "11px", fontWeight: 600,
                        background: tiffLoading ? "#0e2a1a" : "#0d1117",
                        border: `1px solid ${tiffLoading ? "#22c55e" : "#30363d"}`,
                        borderRadius: 6,
                        color: tiffLoading ? "#22c55e" : "#8b949e",
                        cursor: tiffLoading ? "wait" : "pointer",
                        opacity: tiffLoading ? 0.8 : 1,
                      }}
                      onMouseEnter={(e) => { if (!tiffLoading) { (e.currentTarget as HTMLButtonElement).style.borderColor = "#22c55e"; (e.currentTarget as HTMLButtonElement).style.color = "#22c55e"; } }}
                      onMouseLeave={(e) => { if (!tiffLoading) { (e.currentTarget as HTMLButtonElement).style.borderColor = "#30363d"; (e.currentTarget as HTMLButtonElement).style.color = "#8b949e"; } }}
                    >
                      {tiffLoading ? (
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                          <circle cx="8" cy="8" r="6" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="20 10" strokeLinecap="round"/>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                          <path d="M5 8h6M8 5v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                        </svg>
                      )}
                      {tiffLoading ? "Building…" : "GeoTIFF"}
                    </button>
                  </div>
                </div>

                {/* Chart — shown first, before stats/table */}
                <div style={{ height: 180, padding: "10px 4px 0", flexShrink: 0 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 10, left: -8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false}/>
                      <XAxis dataKey="label" tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={{ stroke: "#30363d" }} interval={chartMode === "annual" ? 2 : 11}/>
                      <YAxis
                        tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "monospace" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => v.toFixed(0)}
                        width={36}
                        domain={chartAbsMax > 0 ? [-chartAbsMax, chartAbsMax] : ["auto", "auto"]}
                      />
                      <Tooltip
                        contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 6, fontSize: 11, fontFamily: "monospace", color: "#e6edf3" }}
                        cursor={{ fill: "#21262d" }}
                        formatter={(val: number, _name: string, props: any) => {
                          const isSelectedYear = chartMode === "annual" && props?.payload?.label === String(graceRasterYear);
                          return [
                            <span style={{ color: isSelectedYear ? "#f59e0b" : "#e6edf3" }}>
                              {val?.toFixed(2)} cm{isSelectedYear ? " ★ map" : ""}
                            </span>,
                            isBboxResult ? "Mean LWE" : "LWE"
                          ];
                        }}
                      />
                      <ReferenceLine y={0} stroke="#484f58" strokeWidth={1} strokeDasharray="4 2"/>
                      {/* Amber highlight band for the currently selected raster year */}
                      {chartMode === "annual" && (
                        <ReferenceLine
                          x={String(graceRasterYear)}
                          stroke="#f59e0b"
                          strokeWidth={2}
                          strokeDasharray="3 2"
                          label={{ value: graceRasterYear, position: "top", fontSize: 8, fill: "#f59e0b", fontFamily: "monospace" }}
                        />
                      )}
                      <Bar dataKey="value" maxBarSize={chartMode === "annual" ? 22 : 5} radius={[2, 2, 0, 0]}>
                        {chartData.map((d, i) => (
                          <Cell
                            key={i}
                            fill={barColor(d.value)}
                            stroke={chartMode === "annual" && d.label === String(graceRasterYear) ? "#f59e0b" : "none"}
                            strokeWidth={chartMode === "annual" && d.label === String(graceRasterYear) ? 1.5 : 0}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Location + Stats — below chart */}
                <div style={{ padding: "8px 14px 6px", borderTop: "1px solid #30363d", flexShrink: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "10px", color: isBboxResult ? "#f59e0b" : "#22d3ee", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
                      {isBboxResult ? `Region · ${queryResult.nGridCells} tiles` : "Point"}
                    </span>
                    <span style={{ fontSize: "11px", color: "#8b949e", fontFamily: "monospace" }}>{locationName}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", marginTop: 6 }}>
                    {(([["Min", mn], ["Mean", mean], ["Max", mx]] as [string, number][])).map(([label, v], i) => (
                      <div key={label} style={{ textAlign: "center", padding: "4px 0", borderRight: i < 2 ? "1px solid #30363d" : "none" }}>
                        <div style={{ fontSize: "9px", color: "#8b949e", textTransform: "uppercase", marginBottom: 1 }}>{label}</div>
                        <div style={{ fontSize: "13px", fontWeight: 700, fontFamily: "monospace", color: v >= 0 ? "#22d3ee" : "#f87171" }}>
                          {v >= 0 ? "+" : ""}{v.toFixed(1)}
                        </div>
                        <div style={{ fontSize: "9px", color: "#6e7681" }}>cm LWE</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ padding: "6px 14px", borderTop: "1px solid #30363d", fontSize: 10, color: "#6e7681", flexShrink: 0 }}>
                  JPL GRACE/GRACE-FO Mascon RL06.3 CRI · cm LWE anomaly · 0.5° grid
                  {isBboxResult && <> · spatial mean of {queryResult.nGridCells} pixels</>}
                </div>

                {/* Geology / Hydrogeology — scrollable */}
                <div style={{ borderTop: "1px solid #30363d", flexShrink: 0 }}>
                  <div style={{ padding: "8px 14px 4px", display: "flex", alignItems: "center", gap: 7 }}>
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none">
                      <path d="M2 13L6 7l3 4 2-3 3 5H2z" stroke="#a3a3a3" strokeWidth="1.3" strokeLinejoin="round"/>
                      <circle cx="11" cy="4" r="2" stroke="#a3a3a3" strokeWidth="1.3"/>
                    </svg>
                    <span style={{ fontSize: "10px", fontWeight: 700, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em" }}>Geology &amp; Hydrogeology</span>
                    {locationName && geoSummary && (
                      <span style={{ fontSize: "9px", color: "#484f58", marginLeft: "auto" }}>AI · {locationName}</span>
                    )}
                  </div>
                  <div style={{ padding: "4px 14px 14px", fontSize: "12px", color: "#e6edf3", lineHeight: 1.7 }}>
                    {!geoSummary && !geoLoading && !geoError && (
                      <span style={{ color: "#484f58", fontSize: "11px" }}>Generating geology summary…</span>
                    )}
                    {geoLoading && (
                      <span style={{ color: "#8b949e", fontSize: "11px" }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: "1.5px solid #30363d", borderTopColor: "#a3a3a3", animation: "spin 0.8s linear infinite", marginRight: 8, verticalAlign: "middle" }}/>
                        Generating geology summary…
                      </span>
                    )}
                    {geoError && !geoLoading && <span style={{ color: "#f87171", fontSize: "11px" }}>{geoError}</span>}
                    {geoSummary && !geoLoading && <span>{geoSummary}</span>}
                  </div>
                </div>
              </>
            );
          })()}

          <div style={{ marginTop: "auto", padding: "8px 14px", borderTop: "1px solid #30363d" }}>
            <div style={{ fontSize: "9px", color: "#484f58", marginBottom: 3 }}>Designed by Ken Hardcastle, 2026</div>
            <PerplexityAttribution />
          </div>
        </div>
      </div>

      {/* Bottom geology strip removed — content moved into GRACE panel */}
    </>
  );
}
