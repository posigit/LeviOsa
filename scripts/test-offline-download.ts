/**
 * Pure-function checks for the offline download safeguards.
 * Run: npx tsx scripts/test-offline-download.ts
 */
import assert from "node:assert/strict";
import {
  canonicalMediaKey,
  classifyPieceStatus,
  gapBudget,
  isHardDownloadError,
  isTransientFetchError,
  offlinePieceUrl,
  parseMediaPlaylist,
  pieceOutcome,
  rewritePlaylistForOffline,
  segmentLooksValid,
} from "../lib/offline/hls";

const base = "https://cdn.example.com/pl/master.m3u8";

assert.equal(classifyPieceStatus(403), "auth");
assert.equal(classifyPieceStatus(401, "upstream 401"), "auth");
assert.equal(classifyPieceStatus(200, "bad signature"), "auth");
assert.equal(classifyPieceStatus(404), "dead");
assert.equal(classifyPieceStatus(410), "dead");
assert.equal(classifyPieceStatus(416), "dead");
assert.equal(classifyPieceStatus(429), "network");
assert.equal(classifyPieceStatus(502), "network");
assert.equal(classifyPieceStatus(0), "network");

assert.equal(isTransientFetchError("TimeoutError"), true);
assert.equal(isTransientFetchError("TypeError", "Failed to fetch"), true);
assert.equal(isTransientFetchError("AbortError", "aborted"), false);

assert.equal(
  pieceOutcome({ status: 429, kind: "seg", gaps: 0, segmentCount: 100 }),
  "retry"
);
assert.equal(
  pieceOutcome({ status: 403, kind: "seg", gaps: 0, segmentCount: 100 }),
  "refresh"
);
assert.equal(
  pieceOutcome({
    status: 403,
    kind: "seg",
    gaps: 0,
    segmentCount: 100,
    authAsDead: true,
  }),
  "gap"
);
assert.equal(
  pieceOutcome({ status: 404, kind: "seg", gaps: 0, segmentCount: 100 }),
  "gap"
);
assert.equal(
  pieceOutcome({ status: 404, kind: "key", gaps: 0, segmentCount: 100 }),
  "fail"
);
assert.equal(gapBudget(10), 8);
assert.equal(gapBudget(1000), 30);
assert.equal(
  pieceOutcome({ status: 404, kind: "seg", gaps: 8, segmentCount: 10 }),
  "fail"
);

assert.equal(
  isHardDownloadError("Out of device space — free storage and retry."),
  true
);
assert.equal(
  isHardDownloadError("Not enough device storage for this download."),
  true
);
assert.equal(isHardDownloadError("A piece stalled — tap to retry"), false);
assert.equal(isHardDownloadError("Connection dropped — tap to retry"), false);
assert.equal(
  isHardDownloadError("This source is encrypted and can't be saved offline."),
  true
);
assert.equal(
  isHardDownloadError("Not available in 480p (lowest is 720p) — switch quality in Download settings and retry."),
  true
);

const text = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:4.0,",
  "#EXT-X-BYTERANGE:100@0",
  "seg.mp4",
  "#EXTINF:4.0,",
  "#EXT-X-BYTERANGE:50",
  "seg.mp4",
  '#EXT-X-MAP:URI="init2.mp4"',
  "#EXTINF:4.0,",
  "seg2.ts",
  "",
].join("\n");

const parts = parseMediaPlaylist(text, base);
assert.equal(parts.maps.length, 2);
assert.equal(parts.maps[0]?.url, "https://cdn.example.com/pl/init.mp4");
assert.equal(parts.maps[1]?.url, "https://cdn.example.com/pl/init2.mp4");
assert.equal(parts.segments.length, 3);
assert.deepEqual(parts.segments[0]?.byteRange, { start: 0, length: 100 });
assert.deepEqual(parts.segments[1]?.byteRange, { start: 100, length: 50 });
assert.equal(parts.segments[2]?.byteRange, null);
assert.equal(parts.segments[2]?.url, "https://cdn.example.com/pl/seg2.ts");

const firstUrl = offlinePieceUrl(parts.segments[0]!.url, parts.segments[0]!.byteRange);
const secondUrl = offlinePieceUrl(parts.segments[1]!.url, parts.segments[1]!.byteRange);
assert.notEqual(firstUrl, secondUrl);
assert.ok(decodeURIComponent(firstUrl).includes("@0-99"));
assert.ok(decodeURIComponent(secondUrl).includes("@100-149"));
const rotating = canonicalMediaKey(
  "https://cdn.example.com/s/1.ts?token=AAA&expires=1&asn=9"
);
const rotating2 = canonicalMediaKey(
  "https://cdn.example.com/s/1.ts?token=BBB&expires=2&asn=3"
);
assert.equal(rotating, rotating2);
assert.ok(!rotating.includes("token"));

const gapped = rewritePlaylistForOffline(text, base, new Set([firstUrl]));
assert.ok(gapped.includes("#EXT-X-GAP"));
assert.ok(gapped.includes("#EXT-X-VERSION:8"));
assert.ok(!gapped.includes("#EXT-X-BYTERANGE"));
assert.ok(gapped.includes(firstUrl));
assert.ok(gapped.includes(secondUrl));

const clear = rewritePlaylistForOffline(text, base, new Set());
assert.ok(!clear.includes("#EXT-X-GAP"));
assert.ok(clear.includes("#EXT-X-VERSION:3"));
assert.ok(!clear.includes("#EXT-X-BYTERANGE"));

function bytesOf(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

assert.equal(segmentLooksValid(new Uint8Array([0x47, 0x00, 0x11]), "seg", false), true);
assert.equal(segmentLooksValid(bytesOf("ID3...."), "seg", false), true);
assert.equal(segmentLooksValid(new Uint8Array([0xff, 0xf1, 0x50, 0x80]), "seg", false), true);
assert.equal(segmentLooksValid(new Uint8Array([0x0b, 0x77, 0x00, 0x00]), "seg", false), true);
const fmp4 = new Uint8Array(16);
fmp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0); // ftyp
assert.equal(segmentLooksValid(fmp4, "seg", false), true);
assert.equal(segmentLooksValid(fmp4, "init", false), true);
assert.equal(segmentLooksValid(bytesOf("#EXTM3U\n"), "seg", false), false);
assert.equal(segmentLooksValid(bytesOf("<!DOCTYPE html>"), "seg", false), false);
assert.equal(segmentLooksValid(bytesOf('{"error":1}'), "seg", false), false);
assert.equal(segmentLooksValid(new Uint8Array(0), "seg", false), false);
const key = new Uint8Array(16).fill(7);
assert.equal(segmentLooksValid(key, "key", false), true);
assert.equal(segmentLooksValid(new Uint8Array(15).fill(7), "key", false), false);
const cipher = new Uint8Array(32).fill(7);
assert.equal(segmentLooksValid(cipher, "seg", true), true);
assert.equal(segmentLooksValid(bytesOf("<html>nope</html>"), "seg", true), false);

console.log("offline download checks ok");
