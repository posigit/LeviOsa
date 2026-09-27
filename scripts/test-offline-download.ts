/**
 * Pure-function checks for the offline download safeguards.
 * Run: npx tsx scripts/test-offline-download.ts
 */
import assert from "node:assert/strict";
import {
  canonicalMediaKey,
  classifyPieceStatus,
  gapBudget,
  indexRetryAction,
  isHardDownloadError,
  isTransientFetchError,
  offlinePieceUrl,
  parseMediaPlaylist,
  pieceOutcome,
  rewritePlaylistForOffline,
  rewritePlaylistToIndexUrls,
  segmentIndexUrl,
  segmentLooksValid,
  segmentShouldReject,
} from "../lib/offline/hls";
import {
  nextDownloadedEpisode,
  orderLibraryGroups,
  showNameOf,
} from "../lib/offline/library";
import {
  mergeOfflinePosition,
  serverPositionKey,
  type DownloadRecord,
} from "../lib/offline/store";

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

const signedA = canonicalMediaKey("https://cdn.example.com/a.ts?sig=111&exp=1");
const signedB = canonicalMediaKey("https://cdn.example.com/a.ts?sig=222&exp=2");
assert.notEqual(signedA, signedB);
assert.equal(segmentIndexUrl("e:1:1:1", "v", 4), segmentIndexUrl("e:1:1:1", "v", 4));
assert.notEqual(segmentIndexUrl("e:1:1:1", "v", 4), segmentIndexUrl("e:1:1:1", "v", 5));
assert.equal(indexRetryAction(false), "refresh-index");
assert.equal(indexRetryAction(true), "gap");
assert.equal(segmentShouldReject(bytesOf("<html>nope</html>"), "seg"), true);
assert.equal(segmentShouldReject(bytesOf("#EXTM3U\n"), "seg"), true);
assert.equal(segmentShouldReject(new Uint8Array([0x01, 0x02, 0x03, 0x04]), "seg"), false);
assert.equal(segmentShouldReject(new Uint8Array(0), "seg"), true);

const indexed = rewritePlaylistToIndexUrls(text, [
  "https://app/seg-0",
  "https://app/seg-1",
  "https://app/seg-2",
], { gapIndexes: new Set([0]) });
assert.ok(indexed.includes("#EXT-X-GAP"));
assert.ok(indexed.includes("https://app/seg-0"));
assert.ok(indexed.includes("https://app/seg-1"));
assert.ok(!indexed.includes("seg.mp4"));

/* ------------------------------------------------------------------ */
/* Library order: shows grouped + season/episode sorted, movies split  */
/* out, in-progress rows kept in their slot. Shared by /library and    */
/* the download sheet (lib/offline/library.ts).                        */
/* ------------------------------------------------------------------ */

let fixtureSeq = 100;
function fixture(over: Partial<DownloadRecord> = {}): DownloadRecord {
  fixtureSeq += 1;
  const type = over.type ?? "episode";
  const tmdbId = over.tmdbId ?? 1;
  const season = over.season ?? 1;
  const episode = over.episode ?? 1;
  return {
    key:
      over.key ??
      (type === "movie" ? `m:${tmdbId}` : `e:${tmdbId}:${season}:${episode}`),
    type,
    tmdbId,
    ...(type === "episode" ? { season, episode } : {}),
    title: "Show — S1E1",
    quality: 720,
    usedSource: "vix",
    durationSec: 1400,
    estimateBytes: 1000,
    sizeBytes: 1000,
    bytesDone: 1000,
    totalSegments: 10,
    doneSegments: 10,
    fileUrls: [],
    state: "done",
    subVtt: null,
    subLabel: null,
    subAlts: [],
    segments: null,
    downloadedAt: fixtureSeq,
    lastUsedAt: fixtureSeq,
    ...over,
  };
}

const alphaE1 = fixture({ tmdbId: 10, title: "Alpha — S1E1", season: 1, episode: 1, downloadedAt: 10 });
// Paused mid-download: it must keep its slot between E1 and E3, not sort away.
const alphaE2Paused = fixture({ tmdbId: 10, title: "Alpha — S1E2", season: 1, episode: 2, state: "paused", downloadedAt: 11 });
const alphaE3 = fixture({ tmdbId: 10, title: "Alpha — S1E3", season: 1, episode: 3, downloadedAt: 12 });
// Saved AFTER S1E8 — download order must not decide episode order.
const alphaE8 = fixture({ tmdbId: 10, title: "Alpha — S1E8", season: 1, episode: 8, downloadedAt: 13 });
const alphaS2E1 = fixture({ tmdbId: 10, title: "Alpha — S2E1", season: 2, episode: 1, downloadedAt: 14 });
const betaE1 = fixture({ tmdbId: 20, title: "Beta — S1E1", season: 1, episode: 1, downloadedAt: 20 });
const betaE2Error = fixture({ tmdbId: 20, title: "Beta — S1E2", season: 1, episode: 2, state: "error", error: "Failed", downloadedAt: 21 });
const movie = fixture({ type: "movie", tmdbId: 30, title: "Gamma (2020)", downloadedAt: 30 });

// Deliberately download-ordered (newest first) and mixed across titles.
const mixed = [movie, betaE2Error, alphaS2E1, alphaE3, betaE1, alphaE8, alphaE2Paused, alphaE1];
const mixedBefore = mixed.map((r) => r.key);

const groups = orderLibraryGroups(mixed);
// Movies are their own group; shows order by their newest download.
assert.deepEqual(
  groups.map((g) => g.id),
  ["m:30", "show:20", "show:10"]
);
// A movie row carries no section header (the row already shows the title).
assert.equal(groups[0]!.header, null);
assert.equal(groups[0]!.rows.length, 1);
assert.equal(groups[1]!.header, "Beta");
assert.equal(groups[2]!.header, "Alpha");

// Season then episode, season wrap included: S1E8 before S2E1.
assert.deepEqual(
  groups[2]!.rows.map((r) => r.record.key),
  ["e:10:1:1", "e:10:1:2", "e:10:1:3", "e:10:1:8", "e:10:2:1"]
);
// The paused row stays in episode order — the gap is visible.
assert.equal(groups[2]!.rows[1]!.record.state, "paused");
assert.equal(groups[1]!.rows[1]!.record.state, "error");
// "Season N" only when the show spans more than one season.
assert.deepEqual(
  groups[2]!.rows.map((r) => r.seasonLabel),
  ["Season 1", null, null, null, "Season 2"]
);
assert.deepEqual(
  groups[1]!.rows.map((r) => r.seasonLabel),
  [null, null]
);
// Pure: the caller's array keeps its own order.
assert.deepEqual(mixed.map((r) => r.key), mixedBefore);

// Show name is the title before " — ".
assert.equal(showNameOf("Alpha — S1E8"), "Alpha");
assert.equal(showNameOf("Gamma (2020)"), "Gamma (2020)");

// Next downloaded episode: same show, later in season/episode order, done only.
assert.equal(nextDownloadedEpisode(mixed, alphaE8)?.key, "e:10:2:1");
assert.equal(nextDownloadedEpisode(mixed, alphaE3)?.key, "e:10:1:8");
// Paused E2 is not playable — skip to the next finished episode.
assert.equal(nextDownloadedEpisode(mixed, alphaE1)?.key, "e:10:1:3");
// Nothing later finished → stay on the current ending, no card.
assert.equal(nextDownloadedEpisode(mixed, alphaS2E1), null);
assert.equal(nextDownloadedEpisode([alphaE1, alphaE3], alphaE8), null);
// Movies never advance.
assert.equal(nextDownloadedEpisode(mixed, movie), null);
// Beta's only later episode failed, and Alpha's S2E1 is a different show —
// nothing playable comes after Beta S1E1, so no advance.
assert.equal(nextDownloadedEpisode(mixed, betaE1), null);

/* Server → offline resume merge: the higher of the two wins, a finished
 * server row clears the local one, and a fresh 0-5s start never wipes. */
function expectMerged(
  actual: ReturnType<typeof mergeOfflinePosition>,
  pos: number | null,
  dur = 0
): void {
  if (pos === null) {
    assert.equal(actual, null);
    return;
  }
  assert.ok(actual, `expected a merged position, got ${actual}`);
  assert.equal(actual.pos, pos);
  assert.equal(actual.dur, dur);
}
const localAt = (pos: number, dur: number) => ({ pos, dur, at: 1 });

// No local: server progress seeds the mirror when it is worth resuming.
expectMerged(mergeOfflinePosition(null, 600, 4000), 600, 4000);
// Nothing to resume yet (0-5s) or already finished — nothing is stored.
expectMerged(mergeOfflinePosition(null, 3, 4000), null);
expectMerged(mergeOfflinePosition(null, 3900, 4000), null);
// Absurd rows (NaN / unknown duration) never seed.
expectMerged(mergeOfflinePosition(null, Number.NaN, 4000), null);
// The gap this sync closes: streamed online ahead of the offline bookmark.
expectMerged(mergeOfflinePosition(localAt(300, 4000), 900, 4000), 900, 4000);
// Offline progress ahead of the server keeps the local stop point.
expectMerged(mergeOfflinePosition(localAt(900, 4000), 300, 4000), 900, 4000);
// Server watched to the end (>= 92%) clears the stale Resume line.
expectMerged(mergeOfflinePosition(localAt(900, 4000), 3900, 4000), null);
// A fresh online start must never wipe local progress.
expectMerged(mergeOfflinePosition(localAt(900, 4000), 3, 4000), 900, 4000);
// A server row with no duration only compares positions.
expectMerged(mergeOfflinePosition(localAt(900, 4000), 0, 0), 900, 4000);
// Merged below the resume threshold is dropped, not stored.
expectMerged(mergeOfflinePosition(localAt(2, 4000), 3, 4000), null);

// Server rows land on the download's own key.
assert.equal(
  serverPositionKey({
    mediaType: "tv",
    tmdbId: 10,
    seasonNumber: 1,
    episodeNumber: 2,
    positionSeconds: 0,
    durationSeconds: 0,
  }),
  "e:10:1:2"
);
assert.equal(
  serverPositionKey({
    mediaType: "movie",
    tmdbId: 10,
    seasonNumber: 0,
    episodeNumber: 0,
    positionSeconds: 0,
    durationSeconds: 0,
  }),
  "m:10"
);
assert.equal(
  serverPositionKey({
    mediaType: "tv",
    tmdbId: 10,
    positionSeconds: 0,
    durationSeconds: 0,
  }),
  "e:10:0:0"
);

console.log("offline download checks ok");
