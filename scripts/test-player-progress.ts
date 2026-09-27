/**
 * Pure-function checks for player progress helpers.
 * Run: npx tsx scripts/test-player-progress.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addStartAt,
  formatPlayerClock,
  isFinishedPosition,
  isNearEndPosition,
  isPreSeekNoise,
  isResumablePosition,
  shouldFireEnded,
  shouldSaveProgress,
} from "../lib/player-progress";
import {
  SUB_FONT_SCALE,
  cueTextAt,
  isPromoCue,
  parseVttCues,
  stripAssTags,
} from "../lib/player-subs";
import { CINESRC_SEED_SERVERS, buildCineSrcServerOptions, cineSrcAliasFor, cineSrcServerLabel, embedUrlFor, withCineSrcQuality, withCineSrcServer } from "../lib/embed-sources";
import { DEFAULT_VIX_SETTINGS } from "../lib/vix-settings";
import { NEXT_FAB_RATIO, RESUME_END_RATIO } from "../lib/player-constants";
import { normalizeSegment, parseSegmentSec } from "../lib/introdb";
import { coalesceOutbox } from "../lib/offline/store";
import {
  VOLATILE_PARAMS,
  canonicalMediaKey,
} from "../lib/offline/hls";

assert.equal(isResumablePosition(3, 100), false);
assert.equal(isResumablePosition(10, 100), true);
assert.equal(isResumablePosition(93, 100), false);
assert.equal(isResumablePosition(50, 0), true);

assert.equal(isFinishedPosition(91.9, 100), false);
assert.equal(isFinishedPosition(92, 100), true);
assert.equal(isFinishedPosition(92, 0), false);

assert.equal(isNearEndPosition(95.9, 100, NEXT_FAB_RATIO), false);
assert.equal(isNearEndPosition(96, 100, NEXT_FAB_RATIO), true);

// Outro start is authoritative; 92% is fallback only (never racing).
assert.equal(shouldFireEnded(3431, 3500, 3431), true);
assert.equal(shouldFireEnded(3430, 3500, 3431), false);
assert.equal(shouldFireEnded(3400, 3500, null), true);
assert.equal(shouldFireEnded(3000, 3500, null), false);
assert.equal(shouldFireEnded(3400, 3500, undefined), true);
assert.equal(shouldFireEnded(3400, 0, null), false);
assert.equal(shouldFireEnded(3431, 0, 3431), true);
assert.equal(shouldFireEnded(100, 3500, -5), false);

assert.equal(
  shouldSaveProgress({
    pos: 10,
    force: false,
    lastSavedPos: 10,
    lastSavedAt: Date.now(),
  }),
  false
);
assert.equal(
  shouldSaveProgress({
    pos: 10,
    force: true,
    lastSavedPos: 10,
    lastSavedAt: Date.now(),
  }),
  true
);
assert.equal(
  shouldSaveProgress({
    pos: 20,
    force: false,
    lastSavedPos: 10,
    lastSavedAt: Date.now() - 3000,
  }),
  true
);

assert.equal(formatPlayerClock(65), "1:05");
assert.equal(formatPlayerClock(3661), "1:01:01");

// Resume-seek gate: only near-zero reports are noise. 43:00 → 3:00 must save.
assert.equal(isPreSeekNoise(3, 43 * 60), true);
assert.equal(isPreSeekNoise(0, 43 * 60), true);
assert.equal(isPreSeekNoise(6, 43 * 60), true);
assert.equal(isPreSeekNoise(180, 43 * 60), false);
assert.equal(isPreSeekNoise(43 * 60, 43 * 60), false);
assert.equal(isPreSeekNoise(180, null), false);
assert.equal(isPreSeekNoise(180, 0), false);

assert.equal(
  addStartAt("https://cinesrc.st/embed/tv/1?s=1&e=1&controls=false", 109),
  "https://cinesrc.st/embed/tv/1?s=1&e=1&controls=false&t=109&continueprompt=false"
);
assert.equal(
  addStartAt("https://vidfast.vc/movie/1?autoPlay=true", 50),
  "https://vidfast.vc/movie/1?autoPlay=true&startAt=50"
);
// VidNest resumes TV via progress, movies via startAt.
assert.equal(
  addStartAt("https://vidnest.fun/tv/1/2/3?timeslider=hide", 90),
  "https://vidnest.fun/tv/1/2/3?timeslider=hide&progress=90"
);
assert.equal(
  addStartAt("https://vidnest.fun/movie/1?timeslider=hide", 90),
  "https://vidnest.fun/movie/1?timeslider=hide&startAt=90"
);
// Mapple registry follows the official mapple.rip/watch endpoints (TV too).
assert.equal(
  embedUrlFor("mapple", "movie", 1084199),
  "https://mapple.rip/watch/movie/1084199?autoPlay=true"
);
assert.equal(
  embedUrlFor("mapple", "tv", 83867, 1, 1),
  "https://mapple.rip/watch/tv/83867-1-1?autoPlay=true"
);
// VidNest hides its transport chrome by query param.
assert.ok(
  (embedUrlFor("vidnest", "movie", 324857) ?? "").includes("centerplay=hide")
);

const sampleVtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello <b>world</b>

00:01:00.500 --> 00:01:02.000
Line one<br>Line two
`;
const cues = parseVttCues(sampleVtt);
assert.equal(cues.length, 2);
assert.equal(cues[0].text, "Hello world");
assert.equal(cueTextAt(cues, 2), "Hello world");
assert.equal(cueTextAt(cues, 3), "");
assert.equal(cueTextAt(cues, 61), "Line one\nLine two");
// Positive delay pushes cues later.
const delayed = parseVttCues(sampleVtt, 1);
assert.equal(cueTextAt(delayed, 1.5), "");
assert.equal(cueTextAt(delayed, 2.5), "Hello world");

assert.equal(DEFAULT_VIX_SETTINGS.subBgBlur, "md");
assert.equal(DEFAULT_VIX_SETTINGS.videoFit, "fit");
assert.equal(DEFAULT_VIX_SETTINGS.embedZoom, 1);
assert.equal(DEFAULT_VIX_SETTINGS.autoRotate, true);
assert.equal(SUB_FONT_SCALE.xs, 0.75);

// CineSrc preferred-quality param (Auto clears it).
assert.equal(
  withCineSrcQuality("https://cinesrc.st/embed/movie/1?controls=false", 720),
  "https://cinesrc.st/embed/movie/1?controls=false&quality=720"
);
assert.equal(
  withCineSrcQuality(
    "https://cinesrc.st/embed/movie/1?controls=false&quality=720",
    "auto"
  ),
  "https://cinesrc.st/embed/movie/1?controls=false"
);

// CineSrc sub-server hint (Auto clears it; real ids set lastserver).
// Ids must be CineSrc's own (learned from cinesrc:sourceused) — e.g. Nebula.
assert.equal(
  withCineSrcServer("https://cinesrc.st/embed/movie/1?controls=false", "Nebula"),
  "https://cinesrc.st/embed/movie/1?controls=false&lastserver=Nebula&prioritize=true"
);
assert.equal(
  withCineSrcServer(
    "https://cinesrc.st/embed/movie/1?controls=false&lastserver=Nebula&prioritize=true",
    "auto"
  ),
  "https://cinesrc.st/embed/movie/1?controls=false"
);
// Discovered servers get Greek aliases in order, real id kept as sub-label.
assert.equal(cineSrcAliasFor("nebula", 0), "Zeus");
assert.equal(cineSrcAliasFor("lisbon", 1), "Odysseus");
assert.equal(cineSrcServerLabel("auto"), "Auto");
assert.equal(cineSrcServerLabel("nebula", ["nebula"]), "Zeus");
assert.equal(cineSrcServerLabel("Mystery", []), "Mystery");
assert.deepEqual(buildCineSrcServerOptions(["nebula", "lisbon"]), [
  { id: "auto", name: "Auto" },
  { id: "nebula", name: "Zeus", sub: "nebula" },
  { id: "lisbon", name: "Odysseus", sub: "lisbon" },
]);
// Case-insensitive dedupe: "Nebula" (live event) + "nebula" (seed) = one entry.
assert.deepEqual(buildCineSrcServerOptions(["Nebula", "nebula", "sturm"]), [
  { id: "auto", name: "Auto" },
  { id: "Nebula", name: "Zeus", sub: "Nebula" },
  { id: "sturm", name: "Odysseus", sub: "sturm" },
]);
// Seed list matches the embed's own rotation order (captured 2026-09-11).
assert.deepEqual(CINESRC_SEED_SERVERS.slice(0, 4), ["nebula", "lisbon", "wave", "surge"]);
assert.equal(cineSrcAliasFor("wave", 2), "Hera");
assert.ok(CINESRC_SEED_SERVERS.includes("sturm"));
assert.ok(CINESRC_SEED_SERVERS.includes("brisa"));
assert.equal(DEFAULT_VIX_SETTINGS.cineSrcServer, "auto");
assert.deepEqual(DEFAULT_VIX_SETTINGS.cineSrcKnownServers, CINESRC_SEED_SERVERS);

// Promo cues (VDRK ad spam) are dropped; dialogue is never touched.
assert.equal(isPromoCue("Visit hoofoot.ru to watch all sports"), true);
assert.equal(isPromoCue("Subtitles by https://example.com"), true);
assert.equal(isPromoCue("Hello world"), false);
assert.equal(isPromoCue("I see dead people"), false);
const spammy = `WEBVTT

00:00:01.000 --> 00:00:03.000
Visit hoofoot.ru to watch free

00:00:04.000 --> 00:00:06.000
I see dead people
`;
const clean = parseVttCues(spammy);
assert.equal(clean.length, 1);
assert.equal(clean[0].text, "I see dead people");

assert.equal(RESUME_END_RATIO, 0.92);
assert.equal(NEXT_FAB_RATIO, 0.96);

// IntroDB segment parsing (numbers + clock strings, ms fallback, rejects).
assert.equal(parseSegmentSec(58), 58);
assert.equal(parseSegmentSec("00:58"), 58);
assert.equal(parseSegmentSec("01:02:03"), 3723);
assert.equal(parseSegmentSec(-5), null);
assert.equal(parseSegmentSec("nope"), null);
assert.equal(parseSegmentSec(null), null);
assert.deepEqual(normalizeSegment({ start_sec: 2, end_sec: 58 }), { start: 2, end: 58 });
assert.deepEqual(normalizeSegment({ start_ms: 2000, end_ms: 58000 }), { start: 2, end: 58 });
// Our own proxy returns pre-normalized {start,end} — must survive the client.
assert.deepEqual(normalizeSegment({ start: 307, end: 386 }), { start: 307, end: 386 });
assert.deepEqual(normalizeSegment({ start: "05:07", end: "06:26" }), { start: 307, end: 386 });
assert.equal(normalizeSegment(null), null);
assert.equal(normalizeSegment({ start_sec: 60, end_sec: 30 }), null);

// ASS/SSA remnants are stripped ({\an8} positioning, \N breaks), but
// literal dialogue braces survive.
assert.equal(stripAssTags("{\\an8}Hello world"), "Hello world");
assert.equal(stripAssTags("{\\pos(400,570)\\an7}Hi\\Nthere"), "Hi\nthere");
assert.equal(stripAssTags("I {love} you"), "I {love} you");
assert.equal(stripAssTags("plain dialogue"), "plain dialogue");
const assVtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
{\\an8}I see dead people
`;
const assCues = parseVttCues(assVtt);
assert.equal(assCues.length, 1);
assert.equal(assCues[0].text, "I see dead people");

// Outbox coalescing: last-write-wins per key; DELETE absorbs POSTs.
const e1 = { params: "a", method: "POST", body: '{"p":1}', at: 1, attempts: 0 };
const e2 = { params: "a", method: "POST", body: '{"p":2}', at: 2, attempts: 0 };
assert.deepEqual(coalesceOutbox([e1], e2), [e2]);
assert.deepEqual(
  coalesceOutbox([e1], { params: "a", method: "DELETE", at: 3, attempts: 0 }),
  [{ params: "a", method: "DELETE", at: 3, attempts: 0 }]
);
assert.equal(
  coalesceOutbox([e1], { params: "b", method: "POST", at: 3, attempts: 0 }).length,
  2
);

// Canonical keys: stable across signed-URL rotation (resume depends on it).
assert.equal(
  canonicalMediaKey("https://cdn.example.com/s/1.ts?token=AAA&expires=1"),
  canonicalMediaKey("https://cdn.example.com/s/1.ts?token=BBB&expires=2&asn=3")
);
assert.ok(canonicalMediaKey("https://cdn.example.com/s/1.ts").startsWith("media:"));
assert.deepEqual(VOLATILE_PARAMS, ["token", "expires", "asn"]);

// offline.html parity: the standalone launcher hardcodes the store contract
// (it can't import TS). If these drift, cold-start offline breaks silently.
{
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "offline.html"),
    "utf8"
  );
  for (const needle of [
    "keyval-store",
    '"keyval"',
    "tvtime-download-manifest-v1",
    "tvtime-downloads",
    "tvtime-offline-positions",
    "/api/dl?playlist=",
    "/vendor/hls.min.js",
  ]) {
    assert.ok(html.includes(needle), `offline.html missing ${needle}`);
  }
}

console.log("player-progress: all assertions passed");
