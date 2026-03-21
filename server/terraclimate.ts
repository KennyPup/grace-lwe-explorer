/**
 * TerraClimate data fetcher.
 * Spawns Python subprocess to query THREDDS OPeNDAP for ppt, aet, ro.
 * Caches results to disk as JSON.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const CACHE_DIR = path.join(process.cwd(), "data", "terraclimate_cache");

// Ensure cache dir exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const PYTHON_SCRIPT = path.join(process.cwd(), "fetch_terraclimate.py");

function cacheKey(mode: string, params: Record<string, number>): string {
  const str = `${mode}_${JSON.stringify(params)}`;
  return crypto.createHash("md5").update(str).digest("hex").slice(0, 16);
}

function readCache(key: string): any | null {
  const p = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function writeCache(key: string, data: any): void {
  const p = path.join(CACHE_DIR, `${key}.json`);
  try {
    fs.writeFileSync(p, JSON.stringify(data), "utf8");
  } catch (e) {
    console.error("[TerraClimate] Cache write failed:", e);
  }
}

function runPython(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [PYTHON_SCRIPT, ...args], {
      env: { ...process.env },
      timeout: 5 * 60 * 1000, // 5 min timeout
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("close", (code) => {
      if (stderr) console.error("[TerraClimate Python]", stderr.slice(0, 500));
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Python output parse failed: ${stdout.slice(0, 200)}`));
      }
    });

    child.on("error", (err) => reject(err));
  });
}

export async function queryTerraClimatePoint(lat: number, lon: number): Promise<any> {
  const params = { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
  const key = cacheKey("point", params);
  const cached = readCache(key);
  if (cached) {
    console.log(`[TerraClimate] Cache hit: ${key}`);
    return cached;
  }
  console.log(`[TerraClimate] Fetching point lat=${params.lat} lon=${params.lon}...`);
  const result = await runPython(["point", String(params.lat), String(params.lon)]);
  writeCache(key, result);
  return result;
}

export async function queryTerraClimateBBox(
  minLat: number, maxLat: number, minLon: number, maxLon: number
): Promise<any> {
  // Round to 1 decimal to avoid cache misses for near-identical queries
  const params = {
    minLat: Math.round(minLat * 10) / 10,
    maxLat: Math.round(maxLat * 10) / 10,
    minLon: Math.round(minLon * 10) / 10,
    maxLon: Math.round(maxLon * 10) / 10,
  };
  const key = cacheKey("bbox", params);
  const cached = readCache(key);
  if (cached) {
    console.log(`[TerraClimate] Cache hit: ${key}`);
    return cached;
  }
  console.log(`[TerraClimate] Fetching bbox ${JSON.stringify(params)}...`);
  const result = await runPython([
    "bbox",
    String(params.minLat), String(params.maxLat),
    String(params.minLon), String(params.maxLon),
  ]);
  writeCache(key, result);
  return result;
}
