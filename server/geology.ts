/**
 * Geology & hydrogeology summary via LLM.
 * Uses Anthropic claude_haiku_4_5 for fast, low-cost summaries.
 * Results cached to disk by location key.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const CACHE_DIR = path.join(process.cwd(), "data", "geology_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(lat: number, lon: number, isBbox: boolean): string {
  // Round to 1 decimal for point, 0.5 for bbox — merges nearby queries
  const precision = isBbox ? 1 : 2;
  const factor = Math.pow(10, precision);
  const rLat = Math.round(lat * factor) / factor;
  const rLon = Math.round(lon * factor) / factor;
  const str = `geo_${isBbox ? "bbox" : "pt"}_${rLat}_${rLon}`;
  return crypto.createHash("md5").update(str).digest("hex").slice(0, 16);
}

function readCache(key: string): string | null {
  const p = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")).summary;
    } catch { return null; }
  }
  return null;
}

function writeCache(key: string, summary: string): void {
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ summary }), "utf8");
  } catch (e) {
    console.error("[Geology] Cache write failed:", e);
  }
}

export async function getGeologySummary(params: {
  lat: number;
  lon: number;
  locationName?: string;
  isBbox: boolean;
  minLat?: number; maxLat?: number; minLon?: number; maxLon?: number;
}): Promise<string> {
  const { lat, lon, locationName, isBbox, minLat, maxLat, minLon, maxLon } = params;
  const key = cacheKey(lat, lon, isBbox);
  const cached = readCache(key);
  if (cached) {
    console.log(`[Geology] Cache hit: ${key}`);
    return cached;
  }

  const client = new Anthropic();

  const locDesc = isBbox
    ? `a region bounded by ${minLat?.toFixed(2)}°–${maxLat?.toFixed(2)}°N, ${minLon?.toFixed(2)}°–${maxLon?.toFixed(2)}°E (centred near ${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E)${locationName ? ` — approximately ${locationName}` : ""}`
    : `the point ${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E${locationName ? ` (${locationName})` : ""}`;

  const prompt = `You are a geologist and hydrogeologist. Provide a concise 2–3 sentence summary of the regional geology and hydrogeology for ${locDesc}.

Cover: dominant rock types and geologic age, major structural features if relevant, and the primary aquifer type (e.g. alluvial, fractured bedrock, karst, confined sedimentary). Be specific to this location — do not give generic statements. Write in plain scientific prose only — no bullet points, no headers, no markdown, no title lines. Begin directly with the geological description. Do not mention GRACE or TerraClimate.`;

  console.log(`[Geology] Querying LLM for ${locDesc}`);
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const summary = (message.content[0] as any).text?.trim() ?? "Summary unavailable.";
  writeCache(key, summary);
  return summary;
}
