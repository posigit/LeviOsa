/**
 * Live smoke test for /api/subdl against the real SubDL API (costs a handful
 * of search/download requests from the daily quota).
 *
 * Run: npm run test:subdl
 * Covers: list mode (no query key in fileIds), auto best (VTT), explicit
 * pick, and a TV episode.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { NextRequest } from "next/server";
import { GET } from "../app/api/subdl/route";

if (!process.env.SUBDL_API_KEY) {
  console.error("SUBDL_API_KEY missing — set it in .env.local first.");
  process.exit(1);
}

type Json = Record<string, unknown>;

async function call(query: string): Promise<{ status: number; body: Json }> {
  const req = new NextRequest(`http://localhost:3000/api/subdl?${query}`);
  const res = await GET(req);
  const body = (await res.json()) as Json;
  return { status: res.status, body };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function checkVtt(vtt: unknown, where: string): void {
  assert(typeof vtt === "string" && vtt.length > 0, `${where}: no vtt`);
  assert(
    (vtt as string).trimStart().toUpperCase().startsWith("WEBVTT"),
    `${where}: vtt does not start with WEBVTT`
  );
  assert((vtt as string).includes("-->"), `${where}: no cues`);
}

async function main(): Promise<void> {
  // 1. Movie list — top 3, clean ids, no api_key leakage.
  const list = await call("tmdbId=550&type=movie&list=1");
  assert(list.status === 200, `list status ${list.status}`);
  const items = list.body.items as Array<{ fileId: string; label: string; format: string }>;
  assert(Array.isArray(items) && items.length > 0, "list returned no items");
  for (const it of items) {
    assert(it.fileId.startsWith("/subtitle/"), `fileId not a path: ${it.fileId}`);
    assert(!it.fileId.includes("api_key"), "api_key leaked into fileId");
    assert(it.label.length > 0, "empty label");
  }
  console.log(
    `list ok: ${items.map((i) => `${i.label} [${i.format}]`).join(" | ")}`
  );

  // 2. Movie auto best.
  const best = await call("tmdbId=550&type=movie");
  assert(best.status === 200, `auto status ${best.status}: ${JSON.stringify(best.body)}`);
  checkVtt(best.body.vtt, "auto");
  console.log(`auto ok: ${String(best.body.label)}`);

  // 3. Explicit pick of the first listed file.
  const pick = await call(
    `tmdbId=550&type=movie&fileId=${encodeURIComponent(items[0].fileId)}&label=${encodeURIComponent(items[0].label)}`
  );
  assert(pick.status === 200, `pick status ${pick.status}: ${JSON.stringify(pick.body)}`);
  checkVtt(pick.body.vtt, "pick");
  console.log(`pick ok: ${String(pick.body.label)}`);

  // 4. TV episode (episode-specific unpack files).
  const tv = await call("tmdbId=1396&type=tv&season=1&episode=1");
  assert(tv.status === 200, `tv status ${tv.status}: ${JSON.stringify(tv.body)}`);
  checkVtt(tv.body.vtt, "tv");
  const tvText = tv.body.vtt as string;
  assert(!tvText.includes("\u0600"), "tv result looks Arabic-script (mislabeled EN)");
  console.log(`tv ok: ${String(tv.body.label)}`);

  console.log("\nsubdl smoke test passed");
}

main().catch((err) => {
  console.error("subdl smoke test FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
