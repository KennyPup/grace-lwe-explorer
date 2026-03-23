import type { Express } from "express";
import type { Server } from "http";
import { loadGraceData, getStatus, queryPoint, queryBBox } from "./grace";
import { queryTerraClimatePoint, queryTerraClimateBBox } from "./terraclimate";
import { getGeologySummary } from "./geology";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

  // GeoTIFF export: generates annual mean GeoTIFFs for a bbox, returns a zip
  // ?minLat=35&maxLat=40&minLon=-120&maxLon=-115  (or omit for global)
  app.get("/api/export/geotiff", (req, res) => {
    const { loaded, loadError } = getStatus();
    if (!loaded) {
      return res.status(503).json({ error: loadError || "GRACE data not loaded yet" });
    }

    // Parse bbox — default to global if not supplied
    const minLat = req.query.minLat !== undefined ? parseFloat(req.query.minLat as string) : -89.75;
    const maxLat = req.query.maxLat !== undefined ? parseFloat(req.query.maxLat as string) :  89.75;
    const minLon = req.query.minLon !== undefined ? parseFloat(req.query.minLon as string) : -180.0;
    const maxLon = req.query.maxLon !== undefined ? parseFloat(req.query.maxLon as string) :  180.0;

    if ([minLat, maxLat, minLon, maxLon].some(isNaN)) {
      return res.status(400).json({ error: "Invalid bbox parameters" });
    }

    const DATA_DIR  = path.join(process.cwd(), "data");
    const binFile   = path.join(DATA_DIR, "grace_lwe.bin");
    const metaFile  = path.join(DATA_DIR, "grace_meta.json");
    const scriptFile = path.join(process.cwd(), "server", "export_geotiff.py");
    // For production (compiled), script ships alongside the server
    const scriptAlt  = path.join(path.dirname(process.argv[1] || ""), "export_geotiff.py");
    const script = fs.existsSync(scriptFile) ? scriptFile : scriptAlt;

    const outZip = path.join(os.tmpdir(), `grace_lwe_${Date.now()}.zip`);

    const args = [
      script,
      binFile,
      metaFile,
      String(minLat),
      String(maxLat),
      String(minLon),
      String(maxLon),
      outZip,
    ];

    console.log(`[GeoTIFF] Exporting bbox ${minLat},${maxLat},${minLon},${maxLon}`);

    execFile("python3", args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("[GeoTIFF] Error:", stderr || err.message);
        return res.status(500).json({ error: "GeoTIFF export failed: " + (stderr || err.message) });
      }

      const line = stdout.trim();
      if (!line.startsWith("OK:")) {
        return res.status(500).json({ error: "Export script error: " + line });
      }

      // Parse: OK:<zip>:<N years>:<AxB pixels>
      const parts = line.split(":");
      const nYears = parts[2] || "?";
      const dims   = parts[3] || "?";
      console.log(`[GeoTIFF] Done — ${nYears} years, ${dims} pixels → ${outZip}`);

      // Build a descriptive filename for the download
      const latLabel = `${Math.abs(minLat).toFixed(1)}${minLat>=0?"N":"S"}-${Math.abs(maxLat).toFixed(1)}${maxLat>=0?"N":"S"}`;
      const lonLabel = `${Math.abs(minLon).toFixed(1)}${minLon>=0?"E":"W"}-${Math.abs(maxLon).toFixed(1)}${maxLon>=0?"E":"W"}`;
      const dlName   = `GRACE_LWE_${latLabel}_${lonLabel}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
      res.setHeader("X-Grace-Years", nYears);
      res.setHeader("X-Grace-Dims",  dims);

      const stream = fs.createReadStream(outZip);
      stream.pipe(res);
      stream.on("end", () => {
        fs.unlink(outZip, () => {}); // cleanup temp file
      });
      stream.on("error", (e) => {
        console.error("[GeoTIFF] Stream error:", e);
        res.destroy();
      });
    });
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
