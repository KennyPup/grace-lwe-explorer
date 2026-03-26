import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const META_FILE = path.join(DATA_DIR, "grace_meta.json");
const BIN_FILE = path.join(DATA_DIR, "grace_lwe.bin");
const BIN_GZ_FILE = path.join(DATA_DIR, "grace_lwe.bin.gz");

// Pre-processed data hosted on GitHub Releases (9.4MB compressed vs 251MB raw)
const GITHUB_BIN_URL = "https://github.com/KennyPup/grace-lwe-explorer/releases/download/v1.0-data/grace_lwe.bin.gz";
const GITHUB_META_URL = "https://github.com/KennyPup/grace-lwe-explorer/releases/download/v1.0-data/grace_meta.json";

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

function curlDownload(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const args = ["--location", "--silent", "--output", destPath, "--max-time", "120", "--retry", "3", url];
    const proc = spawn("curl", args);
    proc.on("close", (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`curl exited ${code} downloading ${url}`));
    });
    proc.on("error", (err: Error) => reject(err));
  });
}


export async function loadGraceData(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: download pre-processed binary from GitHub Releases (9.4MB gz, no NASA auth needed)
  if (!fs.existsSync(BIN_FILE)) {
    // Download and decompress gz
    if (!fs.existsSync(BIN_GZ_FILE)) {
      loadProgress = "downloading GRACE data (~9MB)...";
      console.log("[GRACE] Downloading pre-processed binary from GitHub...");
      try {
        await curlDownload(GITHUB_BIN_URL, BIN_GZ_FILE);
        console.log(`[GRACE] Downloaded: ${(fs.statSync(BIN_GZ_FILE).size/1024/1024).toFixed(1)} MB`);
      } catch (err: any) {
        loadError = `Binary download failed: ${err.message}`;
        loadProgress = "error";
        return;
      }
    }
    // Decompress
    loadProgress = "decompressing GRACE data...";
    console.log("[GRACE] Decompressing binary...");
    try {
      const { execSync } = require("child_process");
      execSync(`gunzip -k "${BIN_GZ_FILE}"`, { cwd: DATA_DIR });
      console.log(`[GRACE] Decompressed: ${(fs.statSync(BIN_FILE).size/1024/1024).toFixed(1)} MB`);
    } catch (err: any) {
      loadError = `Decompress failed: ${err.message}`;
      loadProgress = "error";
      return;
    }
  }

  // Step 2: download metadata JSON if needed
  if (!fs.existsSync(META_FILE)) {
    loadProgress = "downloading GRACE metadata...";
    console.log("[GRACE] Downloading metadata from GitHub...");
    try {
      await curlDownload(GITHUB_META_URL, META_FILE);
    } catch (err: any) {
      loadError = `Metadata download failed: ${err.message}`;
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

/**
 * Extract raw per-pixel per-timestep LWE values for a bbox.
 * Returns a compact object suitable for passing to export_geotiff.py via stdin.
 * This keeps all heavy data in Node (already loaded) so the Python subprocess
 * never needs to read the 251 MB binary — avoiding double memory usage.
 */
export function exportBBoxData(minLat: number, maxLat: number, minLon: number, maxLon: number) {
  if (!loaded || !lweBuffer) return null;

  const normMinLon = minLon < 0 ? minLon + 360 : minLon;
  const normMaxLon = maxLon < 0 ? maxLon + 360 : maxLon;

  const latIdxs: number[] = [];
  const lonIdxs: number[] = [];
  for (let i = 0; i < nLat; i++) {
    if (lats[i] >= minLat && lats[i] <= maxLat) latIdxs.push(i);
  }
  for (let i = 0; i < nLon; i++) {
    if (normMinLon <= normMaxLon) {
      if (lons[i] >= normMinLon && lons[i] <= normMaxLon) lonIdxs.push(i);
    } else {
      if (lons[i] >= normMinLon || lons[i] <= normMaxLon) lonIdxs.push(i);
    }
  }

  if (latIdxs.length === 0 || lonIdxs.length === 0) return null;

  // Extract pixel values: shape [nTime][nLat_subset][nLon_subset]
  // Store as flat array to keep JSON compact
  const nT = nTime;
  const nR = latIdxs.length;
  const nC = lonIdxs.length;
  const values: number[] = new Array(nT * nR * nC);
  for (let ti = 0; ti < nT; ti++) {
    for (let ri = 0; ri < nR; ri++) {
      for (let ci = 0; ci < nC; ci++) {
        const v = getLWE(ti, latIdxs[ri], lonIdxs[ci]);
        values[ti * nR * nC + ri * nC + ci] = isValidLWE(v) ? v : -99999;
      }
    }
  }

  return {
    lats:     latIdxs.map(i => lats[i]),
    lons:     lonIdxs.map(i => lons[i] > 180 ? lons[i] - 360 : lons[i]),
    times,
    nT, nR, nC,
    fillValue: -99999,
    values,   // flat float array [nT * nR * nC]
    minLat, maxLat, minLon, maxLon,
  };
}


/**
 * Compute per-pixel annual mean LWE for a given year.
 * Returns a flat grid [nLat * nLon], row 0 = northernmost lat, col 0 = -180°.
 * nodata = -99999.
 */
export function getAnnualMeanGrid(year: number): {
  values: number[];
  nLat: number;
  nLon: number;
  lats: number[];   // length nLat, north→south
  lons: number[];   // length nLon, -180→+180
  vmin: number;
  vmax: number;
  year: number;
  nMonths: number;
} | null {
  if (!loaded || !lweBuffer) return null;

  // Origin for day-offset times
  const originMs = Date.UTC(2002, 0, 1);

  // Collect timestep indices that fall in the requested year
  const yearIdxs: number[] = [];
  for (let ti = 0; ti < nTime; ti++) {
    const d = new Date(originMs + times[ti] * 86400000);
    if (d.getUTCFullYear() === year) yearIdxs.push(ti);
  }
  if (yearIdxs.length === 0) return null;

  const N = yearIdxs.length;
  const total = nLat * nLon;
  const half = nLon / 2; // 360 — split for -180→180 reorder

  // Compute mean per pixel; flip rows (lats are S→N in buffer, need N→S for image)
  // and shift columns from 0→360 to -180→180 simultaneously
  const result: number[] = new Array(total);
  let vmin = Infinity, vmax = -Infinity;

  for (let li = 0; li < nLat; li++) {
    const row = nLat - 1 - li; // flip: li=0 (southmost) → row=359 (bottom)
    for (let col = 0; col < nLon; col++) {
      const loi = (col + half) % nLon; // shift: col 0 → loi 360 (i.e. -180°)
      let sum = 0, cnt = 0;
      for (const ti of yearIdxs) {
        const v = getLWE(ti, li, loi);
        if (isValidLWE(v)) { sum += v; cnt++; }
      }
      const mean = cnt > 0 ? sum / cnt : -99999;
      result[row * nLon + col] = mean;
      if (mean !== -99999) {
        if (mean < vmin) vmin = mean;
        if (mean > vmax) vmax = mean;
      }
    }
  }

  // Build output lat/lon arrays (N→S, -180→+180)
  const outLats: number[] = [];
  for (let i = nLat - 1; i >= 0; i--) outLats.push(lats[i]);
  const outLons: number[] = [];
  for (let col = 0; col < nLon; col++) {
    let lo = lons[(col + half) % nLon];
    if (lo > 180) lo -= 360;
    outLons.push(lo);
  }

  return { values: result, nLat, nLon, lats: outLats, lons: outLons, vmin, vmax, year, nMonths: N };
}
