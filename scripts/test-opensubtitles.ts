/**
 * Live smoke test for /api/vixsrc/subs against the real OpenSubtitles API
 * (costs a couple of download credits from the daily quota).
 *
 * Run: npm run test:opensub
 *
 * The point of the test is the login-failure path: credentials are replaced
 * with garbage before the first call, so /login can never answer. Search,
 * list and download must still work on the Api-Key alone — that is exactly
 * the regression where an expired/rotated key made every call 502 and the
 * CC picker's OpenSubs row reverted to Auto.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { NextRequest } from "next/server";
import { GET } from "../app/api/vixsrc/subs/route";

if (!process.env.OPENSUBTITLES_API_KEY) {
  console.error("OPENSUBTITLES_API_KEY missing — set it in .env first.");
  process.exit(1);
}

// Break login on purpose: everything below must pass without a user token.
process.env.OPENSUBTITLES_USERNAME = "definitely-not-a-user";
process.env.OPENSUBTITLES_PASSWORD = "definitely-not-a-password";

const IMDB = "imdbId=137523"; // Fight Club

type Json = Record<string, unknown>;

async function call(query: string): Promise<{ status: number; body: Json }> {
  const req = new NextRequest(`http://localhost:3000/api/vixsrc/subs?${query}`);
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
  // 1. List mode (what the CC picker's "OpenSubs" row loads) — no login.
  const list = await call(`${IMDB}&list=1`);
  assert(
    list.status === 200,
    `list status ${list.status}: ${JSON.stringify(list.body)}`
  );
  const items = list.body.items as Array<{
    fileId: number;
    label: string;
    format: string;
  }>;
  assert(Array.isArray(items) && items.length > 0, "list returned no items");
  for (const it of items) {
    assert(Number.isFinite(it.fileId) && it.fileId > 0, `bad fileId ${it.fileId}`);
    assert(it.label.length > 0, "empty label");
    assert(!/eyJ|Bearer/.test(it.label), "token leaked into label");
  }
  console.log(
    `list ok: ${items.map((i) => `${i.label} [${i.format}]`).join(" | ")}`
  );

  // 2. Auto best (the cascade a download and an "OpenSubs" click both use).
  const best = await call(IMDB);
  assert(
    best.status === 200,
    `auto status ${best.status}: ${JSON.stringify(best.body)}`
  );
  checkVtt(best.body.vtt, "auto");
  console.log(`auto ok: ${String(best.body.label)}`);

  // 3. Explicit pick of a listed file.
  const pick = await call(
    `${IMDB}&fileId=${items[0].fileId}&label=${encodeURIComponent(items[0].label)}`
  );
  assert(
    pick.status === 200,
    `pick status ${pick.status}: ${JSON.stringify(pick.body)}`
  );
  checkVtt(pick.body.vtt, "pick");
  console.log(`pick ok: ${String(pick.body.label)}`);

  console.log("\nopensubtitles smoke test passed (login was never available)");
}

main().catch((err) => {
  console.error(
    "opensubtitles smoke test FAILED:",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
