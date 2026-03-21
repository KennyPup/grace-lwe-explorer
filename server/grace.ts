import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const NC_FILE = path.join(DATA_DIR, "grace_mascon.nc");
const META_FILE = path.join(DATA_DIR, "grace_meta.json");
const BIN_FILE = path.join(DATA_DIR, "grace_lwe.bin");

// The GRACE RL06.3 CRI-filtered Mascon file — single global netCDF
const GRACE_URL =
  "https://archive.podaac.earthdata.nasa.gov/podaac-ops-cumulus-protected/TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4/GRCTellus.JPL.200204_202601.GLO.RL06.3M.MSCNv04CRI.nc";

// NASA Earthdata credentials — update if account requires password reset
const EARTHDATA_USER = process.env.EARTHDATA_USER || "kchgeo";
const EARTHDATA_PASS = process.env.EARTHDATA_PASS || "1MoyaleHydro!";

// In-memory parsed data
let lats: number[] = [];
let lons: number[] = [];
let times: number[] = [];
let lweBuffer: Buffer | null = null; // raw float32 binary
let nLat = 0;
let nLon = 0;
let nTime = 0;
let loaded = false;
let loadError: string | null = null;
let loadProgress = "idle";

async function getEarthdataToken(user: string, pass: string): Promise<string> {
  const { execSync } = require("child_process");
  console.log("[GRACE] Fetching Earthdata bearer token...");
  const result = execSync(
    `curl -s -X POST https://urs.earthdata.nasa.gov/api/users/token --user "${user}:${pass}"`,
    { encoding: "utf8" }
  );
  const json = JSON.parse(result);
  if (!json.access_token) throw new Error(`Token fetch failed: ${result}`);
  console.log("[GRACE] Got bearer token, expires:", json.expiration_date);
  return json.access_token;
}

function downloadWithCurl(
  url: string,
  token: string,
  destPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const args = [
      "--location",
      "-H", `Authorization: Bearer ${token}`,
      "--output", destPath,
      "--max-time", "600",
      "--retry", "3",
      url
    ];
    console.log("[GRACE] Starting curl download with bearer token...");
    const proc = spawn("curl", args);
    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) { loadProgress = `downloading...`; }
    });
    proc.on("close", (code: number) => {
      if (code === 0) {
        const stats = fs.existsSync(destPath) ? fs.statSync(destPath) : null;
        if (!stats || stats.size < 1000000) {
          const content = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf8").slice(0, 200) : "missing";
          reject(new Error(`Download produced invalid file (${stats?.size ?? 0} bytes): ${content}`));
        } else {
          console.log(`[GRACE] Download complete: ${(stats.size/1024/1024).toFixed(1)} MB`);
          resolve();
        }
      } else {
        reject(new Error(`curl exited with code ${code}`));
      }
    });
    proc.on("error", (err: Error) => reject(new Error(`curl spawn failed: ${err.message}`)));
  });
}

function runPython(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const proc = spawn("python3", [script], { cwd: process.cwd() });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d; console.log("[python]", d.toString().trim()); });
    proc.stderr.on("data", (d: Buffer) => { console.error("[python err]", d.toString().trim()); });
    proc.on("close", (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`Python exited ${code}: ${out}`));
    });
  });
}

export async function loadGraceData(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: download netCDF if needed
  if (!fs.existsSync(NC_FILE)) {
    loadProgress = "downloading GRACE data from NASA Earthdata...";
    console.log("[GRACE] Downloading GRACE netCDF via curl...");
    try {
      const token = await getEarthdataToken(EARTHDATA_USER, EARTHDATA_PASS);
      await downloadWithCurl(GRACE_URL, token, NC_FILE);
    } catch (err: any) {
      loadError = `Download failed: ${err.message}`;
      loadProgress = "error";
      return;
    }
  }

  // Step 2: pre-process with Python if binary not yet generated
  if (!fs.existsSync(BIN_FILE) || !fs.existsSync(META_FILE)) {
    loadProgress = "pre-processing netCDF (Python)...";
    console.log("[GRACE] Running Python pre-processor...");
    const pyScript = path.join(process.cwd(), "preprocess_grace.py");
    try {
      await runPython(pyScript);
    } catch (err: any) {
      loadError = `Pre-process failed: ${err.message}`;
      loadProgress = "error";
      return;
    }
  }

  // Step 3: load binary + metadata into memory
  loadProgress = "loading data into memory...";
  console.log("[GRACE] Loading binary data...");
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    lats = meta.lats;
    lons = meta.lons;
    times = meta.times;
    nLat = meta.nLat;
    nLon = meta.nLon;
    nTime = meta.nTime;

    lweBuffer = fs.readFileSync(BIN_FILE);
    loaded = true;
    loadProgress = "ready";
    console.log(`[GRACE] Ready. ${nTime} months, ${nLat}x${nLon} grid.`);
  } catch (err: any) {
    loadError = `Load failed: ${err.message}`;
    loadProgress = "error";
  }
}

// Get float32 value at [timeIdx, latIdx, lonIdx]
function getLWE(t: number, li: number, loi: number): number {
  const offset = (t * nLat * nLon + li * nLon + loi) * 4;
  return lweBuffer!.readFloatLE(offset);
}

function nearestLatIdx(lat: number): number {
  let best = 0, bestDist = Math.abs(lats[0] - lat);
  for (let i = 1; i < nLat; i++) {
    const d = Math.abs(lats[i] - lat);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function nearestLonIdx(lon: number): number {
  // Lons in file are 0–360
  const normLon = lon < 0 ? lon + 360 : lon;
  let best = 0, bestDist = Math.abs(lons[0] - normLon);
  for (let i = 1; i < nLon; i++) {
    const d = Math.abs(lons[i] - normLon);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Days since 2002-01-01 → YYYY-MM string
function daysToDate(days: number): string {
  const base = new Date("2002-01-01T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + Math.round(days));
  return base.toISOString().slice(0, 7);
}

function isValidLWE(v: number): boolean {
  return isFinite(v) && !isNaN(v) && Math.abs(v) < 10000;
}

function buildAnnual(monthly: { date: string; lwe: number | null }[]) {
  const byYear: Record<string, number[]> = {};
  for (const pt of monthly) {
    if (pt.lwe === null) continue;
    const yr = pt.date.slice(0, 4);
    if (!byYear[yr]) byYear[yr] = [];
    byYear[yr].push(pt.lwe);
  }
  return Object.entries(byYear)
    .map(([year, vals]) => ({
      year: parseInt(year),
      lwe: parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)),
    }))
    .sort((a, b) => a.year - b.year);
}

export function getStatus() {
  return { loaded, loadError, loadProgress, nTimes: nTime, nLat, nLon };
}

export function queryPoint(lat: number, lon: number) {
  if (!loaded || !lweBuffer) return null;
  const li = nearestLatIdx(lat);
  const loi = nearestLonIdx(lon);

  const monthly = times.map((t, ti) => {
    const val = getLWE(ti, li, loi);
    return { date: daysToDate(t), lwe: isValidLWE(val) ? parseFloat(val.toFixed(3)) : null };
  });

  return { lat: lats[li], lon: lons[loi] > 180 ? lons[loi] - 360 : lons[loi], monthly, annual: buildAnnual(monthly) };
}

export function queryBBox(minLat: number, maxLat: number, minLon: number, maxLon: number) {
  if (!loaded || !lweBuffer) return null;

  // Normalize incoming lons to 0–360 (file uses 0–360)
  const normMinLon = minLon < 0 ? minLon + 360 : minLon;
  const normMaxLon = maxLon < 0 ? maxLon + 360 : maxLon;

  const latIdxs: number[] = [];
  const lonIdxs: number[] = [];

  for (let i = 0; i < nLat; i++) {
    if (lats[i] >= minLat && lats[i] <= maxLat) latIdxs.push(i);
  }
  for (let i = 0; i < nLon; i++) {
    // Handle wrap-around (e.g. bbox crossing 0°/360° meridian)
    if (normMinLon <= normMaxLon) {
      if (lons[i] >= normMinLon && lons[i] <= normMaxLon) lonIdxs.push(i);
    } else {
      if (lons[i] >= normMinLon || lons[i] <= normMaxLon) lonIdxs.push(i);
    }
  }

  if (latIdxs.length === 0 || lonIdxs.length === 0) return null;

  const monthly = times.map((t, ti) => {
    let sum = 0, count = 0;
    for (const li of latIdxs) {
      for (const loi of lonIdxs) {
        const val = getLWE(ti, li, loi);
        if (isValidLWE(val)) { sum += val; count++; }
      }
    }
    return { date: daysToDate(t), lwe: count > 0 ? parseFloat((sum / count).toFixed(3)) : null };
  });

  // Build grid cell centres (convert lons back to -180..180)
  const cells: { lat: number; lon: number }[] = [];
  for (const li of latIdxs) {
    for (const loi of lonIdxs) {
      cells.push({ lat: lats[li], lon: lons[loi] > 180 ? lons[loi] - 360 : lons[loi] });
    }
  }

  return {
    bbox: { minLat, maxLat, minLon, maxLon },
    nGridCells: cells.length,
    cells,
    monthly,
    annual: buildAnnual(monthly),
  };
}
