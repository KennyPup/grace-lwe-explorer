import type { Express } from "express";
import type { Server } from "http";
import { loadGraceData, getStatus, queryPoint, queryBBox, exportBBoxData, getAnnualMeanGrid } from "./grace";
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

  // GRACE annual mean raster: ?year=2024
  // Returns a compact JSON grid for canvas rendering on the client.
  // values is a flat [nLat*nLon] array, row 0 = northernmost, col 0 = -180°.
  app.get("/api/grace-raster", (req, res) => {
    const year = parseInt(req.query.year as string) || 2024;
    const grid = getAnnualMeanGrid(year);
    if (!grid) return res.status(503).json({ error: "GRACE data not loaded yet" });
    res.json(grid);
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

  // GeoTIFF export: generates annual mean GeoTIFFs for a bbox, returns a zip.
  // Node extracts just the needed pixels from the already-loaded buffer and
  // pipes them as JSON to Python via stdin — Python never reads the 251MB binary,
  // preventing double memory usage that caused OOM on Render's free tier.
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

    // Extract only the needed pixels in Node (data already in memory)
    const exportData = exportBBoxData(minLat, maxLat, minLon, maxLon);
    if (!exportData) {
      return res.status(400).json({ error: "No GRACE pixels found in bounding box" });
    }

    const scriptFile = path.join(process.cwd(), "server", "export_geotiff.py");
    const scriptAlt  = path.join(path.dirname(process.argv[1] || ""), "export_geotiff.py");
    const script = fs.existsSync(scriptFile) ? scriptFile : scriptAlt;
    const outZip = path.join(os.tmpdir(), `grace_lwe_${Date.now()}.zip`);

    console.log(`[GeoTIFF] Exporting bbox ${minLat},${maxLat},${minLon},${maxLon} — ${exportData.nR}x${exportData.nC} pixels, ${exportData.nT} timesteps`);

    // Spawn Python, pipe the extracted data as JSON via stdin
    const { spawn } = require("child_process");
    const py = spawn("python3", [script, outZip], { timeout: 60000 });

    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    py.on("close", (code: number) => {
      if (code !== 0) {
        console.error("[GeoTIFF] Python error:", stderr);
        return res.status(500).json({ error: "GeoTIFF export failed: " + (stderr.slice(0, 300) || `exit ${code}`) });
      }

      const line = stdout.trim();
      if (!line.startsWith("OK:")) {
        return res.status(500).json({ error: "Export script error: " + line });
      }

      const parts = line.split(":");
      console.log(`[GeoTIFF] Done — ${parts[2]} years, ${parts[3]} pixels`);

      const latLabel = `${Math.abs(minLat).toFixed(1)}${minLat>=0?"N":"S"}-${Math.abs(maxLat).toFixed(1)}${maxLat>=0?"N":"S"}`;
      const lonLabel = `${Math.abs(minLon).toFixed(1)}${minLon>=0?"E":"W"}-${Math.abs(maxLon).toFixed(1)}${maxLon>=0?"E":"W"}`;
      const dlName   = `GRACE_LWE_${latLabel}_${lonLabel}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);

      const stream = fs.createReadStream(outZip);
      stream.pipe(res);
      stream.on("end", () => { fs.unlink(outZip, () => {}); });
      stream.on("error", (e: Error) => { console.error("[GeoTIFF] Stream error:", e); res.destroy(); });
    });

    // Write extracted pixel data as JSON to Python's stdin, then close
    py.stdin.write(JSON.stringify(exportData));
    py.stdin.end();
  });

  // TerraClimate GeoTIFF export
  // Accepts same params as TC point/bbox query; returns zip of annual TIFFs.
  // Data passed via stdin from Node — no large binary re-read, no disk temp files
  // beyond the small output zip (deleted immediately after streaming).
  app.get("/api/export/tc-geotiff", async (req, res) => {
    const lat    = req.query.lat    !== undefined ? parseFloat(req.query.lat    as string) : NaN;
    const lon    = req.query.lon    !== undefined ? parseFloat(req.query.lon    as string) : NaN;
    const minLat = req.query.minLat !== undefined ? parseFloat(req.query.minLat as string) : NaN;
    const maxLat = req.query.maxLat !== undefined ? parseFloat(req.query.maxLat as string) : NaN;
    const minLon = req.query.minLon !== undefined ? parseFloat(req.query.minLon as string) : NaN;
    const maxLon = req.query.maxLon !== undefined ? parseFloat(req.query.maxLon as string) : NaN;

    const isBbox = !isNaN(minLat) && !isNaN(maxLat) && !isNaN(minLon) && !isNaN(maxLon);
    const isPoint = !isNaN(lat) && !isNaN(lon);

    if (!isBbox && !isPoint) {
      return res.status(400).json({ error: "Provide lat/lon for a point or minLat/maxLat/minLon/maxLon for a bbox" });
    }

    try {
      // Fetch TC data (uses cache if available — no extra memory cost)
      let tcData: any;
      if (isBbox) {
        tcData = await queryTerraClimateBBox(minLat, maxLat, minLon, maxLon);
      } else {
        tcData = await queryTerraClimatePoint(lat, lon);
      }

      // Build stdin payload for Python
      const payload = isBbox
        ? { mode: 'bbox', bbox: { minLat, maxLat, minLon, maxLon }, variables: tcData.variables }
        : { mode: 'point', lat: tcData.lat, lon: tcData.lon, variables: tcData.variables };

      const scriptFile = path.join(process.cwd(), "server", "export_tc_geotiff.py");
      const scriptAlt  = path.join(path.dirname(process.argv[1] || ""), "export_tc_geotiff.py");
      const script = fs.existsSync(scriptFile) ? scriptFile : scriptAlt;
      const outZip = path.join(os.tmpdir(), `tc_geotiff_${Date.now()}.zip`);

      console.log(`[TC GeoTIFF] Exporting ${isBbox ? 'bbox' : 'point'}...`);

      const { spawn } = require("child_process");
      const py = spawn("python3", [script, outZip], { timeout: 60000 });

      let stdout = ""; let stderr = "";
      py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      py.on("close", (code: number) => {
        if (code !== 0) {
          console.error("[TC GeoTIFF] Python error:", stderr);
          return res.status(500).json({ error: "TC GeoTIFF export failed: " + (stderr.slice(0, 300) || `exit ${code}`) });
        }
        const line = stdout.trim();
        if (!line.startsWith("OK:")) {
          return res.status(500).json({ error: "TC export script error: " + line });
        }
        const parts = line.split(":");
        console.log(`[TC GeoTIFF] Done — ${parts[2]} years, ${parts[3]} files`);

        // Descriptive download filename
        let dlName: string;
        if (isBbox) {
          const latL = `${Math.abs(minLat).toFixed(1)}${minLat>=0?"N":"S"}-${Math.abs(maxLat).toFixed(1)}${maxLat>=0?"N":"S"}`;
          const lonL = `${Math.abs(minLon).toFixed(1)}${minLon>=0?"E":"W"}-${Math.abs(maxLon).toFixed(1)}${maxLon>=0?"E":"W"}`;
          dlName = `TerraClimate_${latL}_${lonL}.zip`;
        } else {
          dlName = `TerraClimate_${Math.abs(lat).toFixed(3)}${lat>=0?"N":"S"}_${Math.abs(lon).toFixed(3)}${lon>=0?"E":"W"}.zip`;
        }

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);
        const stream = fs.createReadStream(outZip);
        stream.pipe(res);
        stream.on("end", () => { fs.unlink(outZip, () => {}); });
        stream.on("error", (e: Error) => { console.error("[TC GeoTIFF] Stream error:", e); res.destroy(); });
      });

      py.stdin.write(JSON.stringify(payload));
      py.stdin.end();

    } catch (e: any) {
      console.error("[TC GeoTIFF]", e.message);
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
