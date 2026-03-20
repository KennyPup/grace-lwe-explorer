import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Cell,
} from "recharts";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet-draw";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

type ChartMode = "monthly" | "annual";
type StatusData = { loaded: boolean; loadError: string | null; loadProgress: string; nTimes: number };
type SeriesPoint = { date?: string; lwe: number | null; year?: number };
interface QueryResult {
  lat?: number; lon?: number;
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  nGridCells?: number;
  monthly: SeriesPoint[];
  annual: SeriesPoint[];
}

const PANEL_W = 380;
const HDR_H = 46;

export default function GraceExplorer() {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const drawLayerRef = useRef<L.FeatureGroup | null>(null);
  const clickMarkerRef = useRef<L.Marker | null>(null);
  const drawActiveRef = useRef(false);

  // Measure actual available size so layout is pixel-perfect regardless of iframe width
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    // Also watch the root element
    const ro = new ResizeObserver(() => update());
    if (rootRef.current) ro.observe(rootRef.current);
    return () => { window.removeEventListener("resize", update); ro.disconnect(); };
  }, []);

  const mapW = size.w - PANEL_W;
  const bodyH = size.h - HDR_H;

  const [chartMode, setChartMode] = useState<ChartMode>("annual");
  const [pendingQuery, setPendingQuery] = useState<{ type: "point" | "bbox"; params: Record<string, number> } | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  const { data: status } = useQuery<StatusData>({
    queryKey: ["/api/status"],
    refetchInterval: (q) => ((q.state.data as StatusData | undefined)?.loaded ? false : 3000),
  });

  useEffect(() => {
    if (!pendingQuery || !status?.loaded) return;
    runQuery(pendingQuery);
  }, [pendingQuery, status?.loaded]);

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
    } catch (e: any) {
      setQueryError(e.message);
    } finally {
      setQueryLoading(false);
    }
  }, []);

  // Invalidate map size when dimensions change
  useEffect(() => {
    if (leafletMap.current) {
      setTimeout(() => leafletMap.current?.invalidateSize(), 50);
    }
  }, [mapW, bodyH]);

  // Init Leaflet map once
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    const map = L.map(mapRef.current, { center: [20, 0], zoom: 2, zoomControl: true });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19, subdomains: "abcd",
    }).addTo(map);

    const drawLayer = new L.FeatureGroup().addTo(map);
    drawLayerRef.current = drawLayer;

    const cyanIcon = L.divIcon({
      className: "",
      html: `<div style="width:14px;height:14px;border-radius:50%;background:#22d3ee;border:2px solid #fff;box-shadow:0 0 8px #22d3ee80"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (drawActiveRef.current) return;
      const { lat, lng } = e.latlng;
      if (clickMarkerRef.current) map.removeLayer(clickMarkerRef.current);
      clickMarkerRef.current = L.marker([lat, lng], { icon: cyanIcon }).addTo(map);
      drawLayer.clearLayers();
      setPendingQuery({ type: "point", params: { lat, lon: lng } });
    });

    const DrawControl = (L.Control as any).Draw;
    const drawControl = new DrawControl({
      position: "topright",
      draw: {
        polyline: false, polygon: false, circle: false,
        circlemarker: false, marker: false,
        rectangle: {
          shapeOptions: { color: "#22d3ee", weight: 2, fillColor: "#0891b2", fillOpacity: 0.15 },
        },
      },
      edit: { featureGroup: drawLayer, remove: true },
    });
    map.addControl(drawControl);

    map.on("draw:drawstart",   () => { drawActiveRef.current = true; });
    map.on("draw:drawstop",    () => { drawActiveRef.current = false; });
    map.on("draw:editstart",   () => { drawActiveRef.current = true; });
    map.on("draw:editstop",    () => { drawActiveRef.current = false; });
    map.on("draw:deletestart", () => { drawActiveRef.current = true; });
    map.on("draw:deletestop",  () => { drawActiveRef.current = false; });

    // leaflet-draw fires "draw:drawcreated" (not "draw:created")
    map.on("draw:drawcreated", (e: any) => {
      drawActiveRef.current = false;
      drawLayer.clearLayers();
      drawLayer.addLayer(e.layer);
      if (clickMarkerRef.current) { map.removeLayer(clickMarkerRef.current); clickMarkerRef.current = null; }
      const bounds: L.LatLngBounds = e.layer.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      setPendingQuery({ type: "bbox", params: { minLat: sw.lat, maxLat: ne.lat, minLon: sw.lng, maxLon: ne.lng } });
    });

    leafletMap.current = map;
    return () => { map.remove(); leafletMap.current = null; };
  }, []);

  const chartData = queryResult
    ? chartMode === "annual"
      ? queryResult.annual.map((d) => ({ label: String(d.year), value: d.lwe }))
      : queryResult.monthly.filter((d) => d.lwe !== null).map((d) => ({ label: d.date || "", value: d.lwe }))
    : [];

  const maxAbs = chartData.reduce((m, d) => Math.max(m, Math.abs(d.value ?? 0)), 0);
  const barColor = (v: number | null) => v === null ? "#444" : v >= 0 ? "#22d3ee" : "#f87171";

  const isReady = status?.loaded;
  const isError = !!status?.loadError;
  const progress = status?.loadProgress ?? "initializing...";

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
        .leaflet-draw-toolbar a, .leaflet-bar a {
          background-color: #161b22 !important;
          border-color: #30363d !important;
          color: #e6edf3 !important;
        }
        .leaflet-draw-toolbar a:hover, .leaflet-bar a:hover {
          background-color: #21262d !important; color: #22d3ee !important;
        }
        .leaflet-control-attribution {
          background: rgba(13,17,23,0.85) !important;
          color: #6e7681 !important; font-size: 10px !important;
        }
        .leaflet-control-attribution a { color: #22d3ee !important; }
      `}</style>

      {/* Root — pixel-sized, no flexbox constraints */}
      <div ref={rootRef} style={{ position: "fixed", top: 0, left: 0, width: size.w, height: size.h, background: "#0d1117", overflow: "hidden" }}>

        {/* Header */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: HDR_H,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 16px", background: "#161b22", borderBottom: "1px solid #30363d", zIndex: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <svg viewBox="0 0 36 36" width="24" height="24" fill="none">
              <circle cx="18" cy="18" r="16" stroke="#22d3ee" strokeWidth="1.5"/>
              <circle cx="18" cy="18" r="9" stroke="#22d3ee" strokeWidth="1" strokeDasharray="3 2"/>
              <ellipse cx="18" cy="18" rx="16" ry="6" stroke="#5b9bd5" strokeWidth="1"/>
              <circle cx="18" cy="18" r="2.5" fill="#22d3ee"/>
            </svg>
            <span style={{ fontWeight: 600, fontSize: "14px", color: "#e6edf3" }}>GRACE LWE Explorer</span>
            <span style={{ fontSize: "11px", color: "#8b949e", fontFamily: "monospace" }}>
              Terrestrial Water Storage Anomaly · JPL Mascon RL06.3
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{
              width: "8px", height: "8px", borderRadius: "50%",
              background: isError ? "#f85149" : isReady ? "#3fb950" : "#d29922",
              animation: isReady || isError ? "none" : "pulse 1.5s infinite",
            }}/>
            <span style={{ fontSize: "12px", color: "#8b949e" }}>
              {isError ? "Error" : isReady ? `${status!.nTimes} months · 2002–2026` : progress}
            </span>
          </div>
        </div>

        {/* MAP */}
        <div style={{
          position: "absolute", top: HDR_H, left: 0,
          width: mapW, height: bodyH, overflow: "hidden",
        }}>
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} data-testid="map-container"/>

          {/* Hint */}
          <div style={{
            position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)",
            zIndex: 1000, pointerEvents: "none",
            background: "rgba(13,17,23,0.88)", border: "1px solid #30363d",
            borderRadius: "8px", padding: "6px 16px",
            fontSize: "12px", color: "#8b949e", whiteSpace: "nowrap",
          }}>
            {isReady
              ? "Click to query a point · use the □ rectangle button (top-right of map) to draw an AOI"
              : "Loading GRACE data…"}
          </div>

          {/* Loading overlay */}
          {!isReady && !isError && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center",
              justifyContent: "center", background: "rgba(13,17,23,0.78)", zIndex: 2000,
            }}>
              <div style={{
                background: "#161b22", border: "1px solid #30363d",
                borderRadius: "12px", padding: "28px 36px", textAlign: "center",
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: "50%", border: "3px solid #30363d",
                  borderTopColor: "#22d3ee", animation: "spin 1s linear infinite",
                  margin: "0 auto 12px",
                }}/>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#e6edf3", marginBottom: "4px" }}>Loading GRACE Data</div>
                <div style={{ fontSize: "11px", color: "#22d3ee", fontFamily: "monospace" }}>{progress}</div>
              </div>
            </div>
          )}
        </div>

        {/* PANEL */}
        <div style={{
          position: "absolute", top: HDR_H, right: 0,
          width: PANEL_W, height: bodyH,
          display: "flex", flexDirection: "column",
          overflowY: "auto", background: "#161b22", borderLeft: "1px solid #30363d",
        }}>

          {/* Empty */}
          {!queryResult && !queryLoading && !queryError && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px", textAlign: "center" }}>
              <svg viewBox="0 0 64 64" width="48" height="48" fill="none" style={{ opacity: 0.2, marginBottom: 14 }}>
                <circle cx="32" cy="32" r="28" stroke="#e6edf3" strokeWidth="2"/>
                <path d="M20 32h24M32 20v24" stroke="#e6edf3" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              <div style={{ fontSize: "13px", color: "#8b949e", lineHeight: 1.7 }}>
                {isReady ? <>Click any point on the map<br/>or draw a rectangle to query GRACE LWE</> : "Loading data…"}
              </div>
            </div>
          )}

          {/* Querying */}
          {queryLoading && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2px solid #30363d", borderTopColor: "#22d3ee", animation: "spin 0.8s linear infinite", margin: "0 auto 8px" }}/>
                <div style={{ fontSize: "12px", color: "#8b949e" }}>Querying…</div>
              </div>
            </div>
          )}

          {/* Error */}
          {queryError && !queryLoading && (
            <div style={{ padding: 16 }}>
              <div style={{ background: "#1a0e0e", border: "1px solid #5a1a1a", borderRadius: 8, padding: 12, fontSize: 12, color: "#f87171" }}>{queryError}</div>
            </div>
          )}

          {/* Results */}
          {queryResult && !queryLoading && (() => {
            const vals = queryResult.annual.map((d) => d.lwe).filter((v): v is number => v !== null);
            const mn = Math.min(...vals), mx = Math.max(...vals);
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            return (
              <>
                {/* Location */}
                <div style={{ padding: "10px 14px", borderBottom: "1px solid #30363d" }}>
                  {queryResult.lat !== undefined ? (
                    <>
                      <div style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em" }}>Point Query</div>
                      <div style={{ fontSize: "13px", color: "#22d3ee", fontFamily: "monospace", marginTop: 2 }}>
                        {queryResult.lat.toFixed(3)}°N, {queryResult.lon!.toFixed(3)}°E
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Area Query · {queryResult.nGridCells} grid cells (0.5°)
                      </div>
                      <div style={{ fontSize: "12px", color: "#22d3ee", fontFamily: "monospace", marginTop: 2 }}>
                        {queryResult.bbox!.minLat.toFixed(2)}°–{queryResult.bbox!.maxLat.toFixed(2)}°N ·{" "}
                        {queryResult.bbox!.minLon.toFixed(2)}°–{queryResult.bbox!.maxLon.toFixed(2)}°E
                      </div>
                    </>
                  )}
                </div>

                {/* Stats */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: "1px solid #30363d" }}>
                  {([["Min", mn], ["Mean", mean], ["Max", mx]] as [string, number][]).map(([label, v], i) => (
                    <div key={label} style={{ textAlign: "center", padding: "10px 4px", borderRight: i < 2 ? "1px solid #30363d" : "none" }}>
                      <div style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: "16px", fontWeight: 700, fontFamily: "monospace", color: v >= 0 ? "#22d3ee" : "#f87171" }}>
                        {v >= 0 ? "+" : ""}{v.toFixed(1)}
                      </div>
                      <div style={{ fontSize: "10px", color: "#8b949e" }}>cm LWE</div>
                    </div>
                  ))}
                </div>

                {/* Toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderBottom: "1px solid #30363d" }}>
                  <span style={{ fontSize: "11px", color: "#8b949e" }}>LWE Anomaly (cm)</span>
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
                </div>

                {/* Chart */}
                <div style={{ height: 220, padding: "12px 4px 0" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 10, left: -8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false}/>
                      <XAxis dataKey="label" tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={{ stroke: "#30363d" }} interval={chartMode === "annual" ? 2 : 11}/>
                      <YAxis tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(0)} width={36}/>
                      <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 6, fontSize: 11, fontFamily: "monospace", color: "#e6edf3" }} cursor={{ fill: "#21262d" }} formatter={(val: number) => [`${val?.toFixed(2)} cm`, "LWE"]}/>
                      <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 2"/>
                      <Bar dataKey="value" maxBarSize={chartMode === "annual" ? 22 : 5} radius={[2, 2, 0, 0]}>
                        {chartData.map((d, i) => <Cell key={i} fill={barColor(d.value)}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Annual table */}
                <div style={{ padding: "12px 14px 8px", borderTop: "1px solid #30363d" }}>
                  <div style={{ fontSize: "10px", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                    Annual Mean LWE by Year
                  </div>
                  <div style={{ overflowY: "auto", maxHeight: 280 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #30363d" }}>
                          {["Year", "LWE (cm)", ""].map((h, i) => (
                            <th key={i} style={{ padding: "4px 6px", textAlign: i === 0 ? "left" : "right", fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResult.annual.map((row) => {
                          const v = row.lwe ?? 0;
                          const pct = maxAbs > 0 ? Math.abs(v) / maxAbs : 0;
                          const isPos = v >= 0;
                          return (
                            <tr key={row.year} style={{ borderBottom: "1px solid #0d1117" }}>
                              <td style={{ padding: "5px 6px", fontSize: 12, color: "#e6edf3", fontFamily: "monospace" }}>{row.year}</td>
                              <td style={{ padding: "5px 6px", textAlign: "right", fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: isPos ? "#22d3ee" : "#f87171" }}>
                                {isPos ? "+" : ""}{v.toFixed(2)}
                              </td>
                              <td style={{ padding: "5px 6px", width: 70 }}>
                                <div style={{ height: 5, width: `${Math.round(pct * 62)}px`, background: isPos ? "#0e4c5a" : "#5a1a1a", borderRadius: 2, border: `1px solid ${isPos ? "#22d3ee" : "#f87171"}` }}/>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ padding: "6px 14px", borderTop: "1px solid #30363d", fontSize: 10, color: "#6e7681" }}>
                  JPL GRACE/GRACE-FO Mascon RL06.3 CRI · cm LWE anomaly · 0.5° grid
                </div>
              </>
            );
          })()}

          <div style={{ marginTop: "auto", padding: "8px 14px", borderTop: "1px solid #30363d" }}>
            <PerplexityAttribution />
          </div>
        </div>
      </div>
    </>
  );
}
