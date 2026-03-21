import type { Express } from "express";
import type { Server } from "http";
import { loadGraceData, getStatus, queryPoint, queryBBox } from "./grace";
import { queryTerraClimatePoint, queryTerraClimateBBox } from "./terraclimate";
import { getGeologySummary } from "./geology";

export function registerRoutes(httpServer: Server, app: Express) {
  // Kick off data load on startup (non-blocking)
  loadGraceData().catch((err) => console.error("[GRACE] Load error:", err));

  // Status endpoint — poll this to know when data is ready
  app.get("/api/status", (_req, res) => {
    res.json(getStatus());
  });

  // Point query: ?lat=36.5&lon=-118.5
  app.get("/api/query/point", (req, res) => {
    const { loaded, loadError } = getStatus();
    if (!loaded) {
      return res.status(503).json({ error: loadError || "Data not loaded yet", status: getStatus() });
    }
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }
    const result = queryPoint(lat, lon);
    if (!result) return res.status(500).json({ error: "Query failed" });
    res.json(result);
  });

  // BBox query: ?minLat=35&maxLat=40&minLon=-120&maxLon=-115
  app.get("/api/query/bbox", (req, res) => {
    const { loaded, loadError } = getStatus();
    if (!loaded) {
      return res.status(503).json({ error: loadError || "Data not loaded yet", status: getStatus() });
    }
    const minLat = parseFloat(req.query.minLat as string);
    const maxLat = parseFloat(req.query.maxLat as string);
    const minLon = parseFloat(req.query.minLon as string);
    const maxLon = parseFloat(req.query.maxLon as string);
    if ([minLat, maxLat, minLon, maxLon].some(isNaN)) {
      return res.status(400).json({ error: "Invalid bbox parameters" });
    }
    const result = queryBBox(minLat, maxLat, minLon, maxLon);
    if (!result) return res.status(500).json({ error: "Query failed — no grid cells in bbox" });
    res.json(result);
  });

  // TerraClimate point query: ?lat=36.5&lon=-118.5
  app.get("/api/terraclimate/point", async (req, res) => {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }
    try {
      const result = await queryTerraClimatePoint(lat, lon);
      res.json(result);
    } catch (e: any) {
      console.error("[TC point]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Geology/hydrogeology summary for a point or bbox
  app.get("/api/geology", async (req, res) => {
    const lat  = parseFloat(req.query.lat  as string);
    const lon  = parseFloat(req.query.lon  as string);
    const name = (req.query.name as string) || "";
    const minLat = req.query.minLat !== undefined ? parseFloat(req.query.minLat as string) : undefined;
    const maxLat = req.query.maxLat !== undefined ? parseFloat(req.query.maxLat as string) : undefined;
    const minLon = req.query.minLon !== undefined ? parseFloat(req.query.minLon as string) : undefined;
    const maxLon = req.query.maxLon !== undefined ? parseFloat(req.query.maxLon as string) : undefined;
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: "Invalid lat/lon" });
    const isBbox = minLat !== undefined && maxLat !== undefined && minLon !== undefined && maxLon !== undefined;
    try {
      const summary = await getGeologySummary({ lat, lon, locationName: name || undefined, isBbox, minLat, maxLat, minLon, maxLon });
      res.json({ summary });
    } catch (e: any) {
      console.error("[Geology]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // TerraClimate bbox query: ?minLat=35&maxLat=40&minLon=-120&maxLon=-115
  app.get("/api/terraclimate/bbox", async (req, res) => {
    const minLat = parseFloat(req.query.minLat as string);
    const maxLat = parseFloat(req.query.maxLat as string);
    const minLon = parseFloat(req.query.minLon as string);
    const maxLon = parseFloat(req.query.maxLon as string);
    if ([minLat, maxLat, minLon, maxLon].some(isNaN)) {
      return res.status(400).json({ error: "Invalid bbox parameters" });
    }
    try {
      const result = await queryTerraClimateBBox(minLat, maxLat, minLon, maxLon);
      res.json(result);
    } catch (e: any) {
      console.error("[TC bbox]", e.message);
      res.status(500).json({ error: e.message });
    }
  });
}
