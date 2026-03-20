import type { Express } from "express";
import type { Server } from "http";
import { loadGraceData, getStatus, queryPoint, queryBBox } from "./grace";

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
}
