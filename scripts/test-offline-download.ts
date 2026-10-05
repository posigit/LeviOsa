/**
 * Pure-function checks for the offline download safeguards.
 * Run: npx tsx scripts/test-offline-download.ts
 */
import assert from "node:assert/strict";
import {
  buildOfflineMaster,
  canonicalMediaKey,
  classifyPieceStatus,
  dlPlaylistUrl,
  gapBudget,
  indexRetryAction,
  isHardDownloadError,
  isTransientFetchError,
  offlinePieceUrl,
  parseMasterSubtitles,
  parseMasterVariants,
  parseMediaPlaylist,
  pieceOutcome,
  rewritePlaylistForOffline,
  rewritePlaylistToIndexUrls,
  segmentIndexUrl,
  segmentLooksValid,
  segmentShouldReject,
  withEndlist,
  withOfflineSubtitles,
} from "../lib/offline/hls";
import {
  nextDownloadedEpisode,
  orderLibraryGroups,
  showNameOf,
} from "../lib/offline/library";
import {
  isPlaybackInUse,
  mergeOfflinePosition,
  missingCount,
  serverPositionKey,
  setPlaybackInUse,
  stillThumbUrl,
  cacheStillThumb,
  type DownloadRecord,
} from "../lib/offline/store";
import { parseVttTime } from "../lib/player-subs";
import {
  DOWNLOAD_SOURCES,
  PINNED_CONFIRM_DELAYS_MS,
  downloadCandidates,
  mirrorIdentity,
  needsGiveWayConfirm,
  pinnedDownloadSource,
  pinnedResolveGivesWay,
} from "../lib/offline/candidates";
import {
  encodeRendition,
  isShrunkParse,
  pieceInfo,
  planRenditionWipe,
} from "../lib/offline/rendition";

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
assert.equal(
  isHardDownloadError(
    "Downloads need the stream resolver — VIX_RESOLVER_URL isn't set on this deployment."
  ),
  true
);
assert.equal(
  isHardDownloadError(
    "Stream resolver failed (timeout) If it names the resolver, revive/redeploy that service, then retry."
  ),
  false
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
assert.equal(parts.sampleAes, false);
const sampleAes = parseMediaPlaylist(
  [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="https://cdn.example.com/key",KEYFORMAT="identity"',
    "#EXTINF:4.0,",
    "seg.ts",
    "",
  ].join("\n"),
  base
);
assert.equal(sampleAes.sampleAes, true);
const fairplay = parseMediaPlaylist(
  [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"',
    "#EXTINF:4.0,",
    "seg.ts",
    "",
  ].join("\n"),
  base
);
assert.equal(fairplay.sampleAes, true);
assert.equal(fairplay.aes128, false);
const clearAes = parseMediaPlaylist(
  [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key"',
    "#EXTINF:4.0,",
    "seg.ts",
    "",
  ].join("\n"),
  base
);
assert.equal(clearAes.sampleAes, false);
assert.equal(clearAes.aes128, true);
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

/* Mixed tag orders in ONE playlist: before the first EXTINF (the fully
   ungated position), after EXTINF (classic), and between a URI and the next
   EXTINF. Each pass must bind every range to the following URI — a dropped
   tag loses the range (corrupt bytes), a leaked one hits an index URL. */
const reversed = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-BYTERANGE:100@0",
  "#EXTINF:4.0,",
  "seg.mp4",
  "#EXTINF:4.0,",
  "#EXT-X-BYTERANGE:50",
  "seg.mp4",
  "#EXT-X-BYTERANGE:25",
  "#EXTINF:4.0,",
  "seg.mp4",
  "",
].join("\n");
const rParts = parseMediaPlaylist(reversed, base);
assert.equal(rParts.segments.length, 3);
assert.deepEqual(rParts.segments[0]?.byteRange, { start: 0, length: 100 });
assert.deepEqual(rParts.segments[1]?.byteRange, { start: 100, length: 50 });
assert.deepEqual(rParts.segments[2]?.byteRange, { start: 150, length: 25 });
const rRewritten = rewritePlaylistForOffline(reversed, base, new Set());
assert.ok(!rRewritten.includes("#EXT-X-BYTERANGE"));
assert.ok(decodeURIComponent(rRewritten).includes("@0-99"));
assert.ok(decodeURIComponent(rRewritten).includes("@100-149"));
assert.ok(decodeURIComponent(rRewritten).includes("@150-174"));
const rIndexed = rewritePlaylistToIndexUrls(reversed, [
  "https://app/rseg-0",
  "https://app/rseg-1",
  "https://app/rseg-2",
]);
assert.ok(!rIndexed.includes("#EXT-X-BYTERANGE"));
assert.ok(rIndexed.includes("https://app/rseg-0"));
assert.ok(rIndexed.includes("https://app/rseg-2"));
assert.ok(!rIndexed.includes("seg.mp4"));

/* ------------------------------------------------------------------ */
/* ENDLIST + subtitle capture: stored playlists must read as VOD, and  */
/* the offline master carries the captured caption rendition instead of */
/* remote SUBTITLES groups (which can never load offline).             */
/* ------------------------------------------------------------------ */

// A terminated media playlist passes through untouched (idempotent).
const ended = "#EXTM3U\n#EXTINF:4.0,\nseg.ts\n#EXT-X-ENDLIST";
assert.equal(withEndlist(ended), ended);
// Masters (no EXTINF) are never terminated.
const master = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="a.m3u8"',
  "#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO=\"aud\"",
  "v.m3u8",
].join("\n");
assert.equal(withEndlist(master), master);
// An unterminated VOD playlist gains the tag exactly once.
const live = "#EXTM3U\n#EXTINF:4.0,\nseg.ts";
const liveEnded = withEndlist(live);
assert.ok(liveEnded.includes("#EXT-X-ENDLIST"));
assert.equal(withEndlist(liveEnded), liveEnded);

const subMaster = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Forced",LANGUAGE="en",URI="subs/forced.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="a.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud",SUBTITLES="subs"',
  "v.m3u8",
].join("\n");

// Renditions parse with resolved URLs + the raw URI for rewrites.
const parsedSubs = parseMasterSubtitles(subMaster, base);
assert.equal(parsedSubs.length, 2);
assert.equal(parsedSubs[0]?.groupId, "subs");
assert.equal(parsedSubs[0]?.name, "English");
assert.equal(parsedSubs[0]?.language, "en");
assert.equal(parsedSubs[0]?.isDefault, true);
assert.equal(parsedSubs[0]?.rawUri, "subs/en.m3u8");
assert.equal(parsedSubs[0]?.url, "https://cdn.example.com/pl/subs/en.m3u8");
assert.equal(parsedSubs[1]?.isDefault, false);

// The picked variant carries its subtitle group (engine matches on it).
const parsedVariants = parseMasterVariants(subMaster, base);
assert.equal(parsedVariants.length, 1);
assert.equal(parsedVariants[0]?.subGroup, "subs");
assert.equal(parsedVariants[0]?.audioGroup, "aud");

// Capture: one rendition replaces every original, before the STREAM-INF.
const stored = "https://app/idx:e:10:1:2:sp:0";
const attached = withOfflineSubtitles(subMaster, {
  name: "English",
  language: "en",
  uri: stored,
});
assert.ok(attached.includes('GROUP-ID="offline-subs"'));
assert.ok(attached.includes(`URI="${stored}"`));
assert.ok(attached.includes('SUBTITLES="offline-subs"'));
assert.ok(!attached.includes("subs/en.m3u8"));
assert.ok(!attached.includes("subs/forced.m3u8"));
assert.ok(attached.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") < attached.indexOf("#EXT-X-STREAM-INF"));
// Audio group survives untouched.
assert.ok(attached.includes('TYPE=AUDIO'));
// Exactly one subtitle rendition + one attr reference.
assert.equal((attached.match(/TYPE=SUBTITLES/g) ?? []).length, 1);
assert.equal((attached.match(/SUBTITLES="offline-subs"/g) ?? []).length, 1);

// No capture: every remote subtitle group is stripped (they'd 404 offline).
const dropped = withOfflineSubtitles(subMaster, null);
assert.ok(!dropped.includes("TYPE=SUBTITLES"));
assert.ok(!dropped.includes('SUBTITLES="subs"'));
assert.ok(dropped.includes('TYPE=AUDIO'));
assert.ok(dropped.includes("v.m3u8"));

// A media playlist (no STREAM-INF) with nothing to attach passes through.
assert.equal(withOfflineSubtitles(live, null), live);

// Round-2 #14: muxed-audio top level — the engine wraps the stored variant
// in a synthetic master so the captured rendition isn't a dead line that
// no playlist ever references.
const wrapped = withOfflineSubtitles(
  buildOfflineMaster({
    variant: {
      bandwidth: 4_000_000,
      height: 720,
      width: 1280,
      codecs: "avc1.64001f,mp4a.40.2",
      audioGroup: null,
      subGroup: "subs",
      url: "https://cdn.example.com/v/720.m3u8",
    },
    videoPlaylistUrl: "https://app/idx:e:10:1:2:vp:0",
    audio: null,
    audioPlaylistUrl: null,
  }),
  { name: "English", language: "en", uri: "https://app/idx:e:10:1:2:sp:0" }
);
assert.equal((wrapped.match(/#EXT-X-STREAM-INF/g) ?? []).length, 1);
assert.ok(wrapped.includes("https://app/idx:e:10:1:2:vp:0"));
assert.ok(wrapped.includes('SUBTITLES="offline-subs"'));
assert.equal((wrapped.match(/TYPE=SUBTITLES/g) ?? []).length, 1);
assert.ok(!wrapped.includes("TYPE=AUDIO"));
assert.ok(wrapped.indexOf("TYPE=SUBTITLES") < wrapped.indexOf("#EXT-X-STREAM-INF"));

/* ------------------------------------------------------------------ */
/* SRT-style comma timestamps: Number("01,500") is NaN, which silently  */
/* dropped every cue from OpenSubtitles downloads.                     */
/* ------------------------------------------------------------------ */
assert.equal(parseVttTime("00:01:02.500"), 62.5);
assert.equal(parseVttTime("00:01:02,500"), 62.5);
assert.equal(parseVttTime("01:02.500"), 62.5);
assert.equal(parseVttTime("01:02,500"), 62.5);
assert.equal(parseVttTime("00:00:00,000"), 0);

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

/* Honest partial state: `done` rows can owe segments, everything else
 * never does (a repairing row shows progress, not a badge). */
assert.equal(missingCount(fixture()), 0);
assert.equal(
  missingCount(
    fixture({ missing: [{ role: "v", index: 3 }, { role: "s", index: 0 }] })
  ),
  2
);
assert.equal(missingCount(fixture({ missing: [] })), 0);
assert.equal(
  missingCount(fixture({ state: "paused", missing: [{ role: "a", index: 1 }] })),
  0
);

/* The download being played is pinned against quota LRU eviction. */
setPlaybackInUse("e:10:1:1");
assert.equal(isPlaybackInUse("e:10:1:1"), true);
assert.equal(isPlaybackInUse("e:10:1:2"), false);
setPlaybackInUse(null);
assert.equal(isPlaybackInUse("e:10:1:1"), false);

/* Source cascade: fixed order, never the player's preferredSource. */
assert.deepEqual(DOWNLOAD_SOURCES, ["vidsrc-sh", "vidsrc-pm", "vix"]);
assert.deepEqual(downloadCandidates(null), ["vidsrc-sh", "vidsrc-pm", "vix"]);
assert.deepEqual(downloadCandidates("vidsrc-pm"), [
  "vidsrc-pm",
  "vidsrc-sh",
  "vix",
]);

/* Pinning only applies when the record owns bytes, only to live cascade
 * sources, and goated backend names / embeds / junk never pin. */
assert.equal(pinnedDownloadSource("vidsrc-sh", true), "vidsrc-sh");
assert.equal(pinnedDownloadSource("vix", true), "vix");
assert.equal(pinnedDownloadSource("vidsrc-sh", false), null);
assert.equal(pinnedDownloadSource("", true), null);
assert.equal(pinnedDownloadSource(undefined, true), null);
assert.equal(pinnedDownloadSource("goated", true), null);
assert.equal(pinnedDownloadSource("valenox", true), null);
assert.equal(pinnedDownloadSource("orbit", true), null);
assert.equal(pinnedDownloadSource("vidy", true), null);

/* A pinned source gives way ONLY on a permanent-for-title verdict —
 * transient failures must stop the cascade so the retry re-pins. */
assert.equal(pinnedResolveGivesWay("not_found"), true);
assert.equal(pinnedResolveGivesWay("no_streams"), true);
assert.equal(pinnedResolveGivesWay("upstream_unreachable"), false);
assert.equal(pinnedResolveGivesWay("blocked"), false);
assert.equal(pinnedResolveGivesWay("resolution_failed"), false);
assert.equal(pinnedResolveGivesWay("sign_failed"), false);
assert.equal(pinnedResolveGivesWay(undefined), false);

/* Case 3 — confirm before giving way: a run that owns bytes re-checks a
 * "permanent" verdict on its pinned source (transient 404s map to
 * not_found/no_streams), while a run with nothing stored cascades at once. */
assert.equal(needsGiveWayConfirm(true, "vidsrc-sh", "vidsrc-sh", "not_found"), true);
assert.equal(needsGiveWayConfirm(true, "vidsrc-sh", "vidsrc-sh", "no_streams"), true);
assert.equal(needsGiveWayConfirm(false, "vidsrc-sh", "vidsrc-sh", "not_found"), false);
assert.equal(needsGiveWayConfirm(true, "vidsrc-sh", "vidsrc-sh", "blocked"), false);
assert.equal(needsGiveWayConfirm(true, "vidsrc-pm", "vidsrc-sh", "not_found"), false);
assert.equal(needsGiveWayConfirm(true, "vidsrc-sh", null, "not_found"), false);
assert.ok(PINNED_CONFIRM_DELAYS_MS.length > 0);
assert.ok(PINNED_CONFIRM_DELAYS_MS.every((ms) => ms > 0));

/* Mirror identity survives re-signing: same target, new exp/sig (and a
 * rotated query on the target) still matches; a different mirror doesn't. */
const mirrorA = `/api/vidsrc-sh/media?url=${encodeURIComponent(
  "https://edge1.example/hls/master.m3u8?tok=aaa"
)}&exp=111&sig=dead`;
const mirrorA2 = `/api/vidsrc-sh/media?url=${encodeURIComponent(
  "https://edge1.example/hls/master.m3u8?tok=zzz"
)}&exp=222&sig=beef`;
const mirrorB = `/api/vidsrc-sh/media?url=${encodeURIComponent(
  "https://edge2.example/chunks/master.m3u8?tok=aaa"
)}&exp=111&sig=dead`;
assert.equal(mirrorIdentity(mirrorA), mirrorIdentity(mirrorA2));
assert.notEqual(mirrorIdentity(mirrorA), mirrorIdentity(mirrorB));
assert.equal(
  mirrorIdentity("https://plain.example/master.m3u8?v=2#frag"),
  "https://plain.example/master.m3u8"
);

/* Rendition guard: only the groups whose cut changed are dropped. */
const nextSig = encodeRendition("720:1000", "150", "4");
assert.equal(nextSig, "720:1000|150|4");
assert.deepEqual(
  planRenditionWipe({ stored: nextSig, next: nextSig, sourceChanged: false }),
  { groups: [], hadStored: true }
);
assert.deepEqual(
  planRenditionWipe({ stored: null, next: nextSig, sourceChanged: false }),
  { groups: [], hadStored: false }
);
/* Legacy signature tracked no subs: video/audio survive, subs drop. */
assert.deepEqual(
  planRenditionWipe({
    stored: "720:1000:150",
    next: nextSig,
    sourceChanged: false,
  }),
  { groups: ["subs"], hadStored: true }
);
/* An audio-track flap keeps paid-for video. */
assert.deepEqual(
  planRenditionWipe({
    stored: encodeRendition("720:1000", "148", "4"),
    next: nextSig,
    sourceChanged: false,
  }),
  { groups: ["audio"], hadStored: true }
);
/* Variant drift keeps a matching audio rendition; height/count drift drops
 * video; a subs-only change touches nothing else. */
assert.deepEqual(
  planRenditionWipe({
    stored: encodeRendition("480:1000", "150", "4"),
    next: nextSig,
    sourceChanged: false,
  }),
  { groups: ["video"], hadStored: true }
);
assert.deepEqual(
  planRenditionWipe({
    stored: encodeRendition("720:999", "150", "4"),
    next: nextSig,
    sourceChanged: false,
  }),
  { groups: ["video"], hadStored: true }
);
assert.deepEqual(
  planRenditionWipe({
    stored: encodeRendition("720:1000", "150", "3"),
    next: nextSig,
    sourceChanged: false,
  }),
  { groups: ["subs"], hadStored: true }
);
/* A source change serves another copy: counts can coincide, so every
 * stored piece is distrusted. */
assert.deepEqual(
  planRenditionWipe({
    stored: nextSig,
    next: nextSig,
    sourceChanged: true,
  }),
  { groups: ["video", "audio", "subs"], hadStored: true }
);

/* Shrink guard: a materially shorter parse at the same source is a
 * truncated playlist — keep stored bytes; re-segmentation (same duration)
 * and rounding slack must NOT trip it, and a source change bypasses it. */
assert.equal(
  isShrunkParse({ storedDurationSec: 3480, nextDurationSec: 3100, sourceChanged: false }),
  true
);
assert.equal(
  isShrunkParse({ storedDurationSec: 3480, nextDurationSec: 3410, sourceChanged: false }),
  true
);
assert.equal(
  isShrunkParse({ storedDurationSec: 3480, nextDurationSec: 3411, sourceChanged: false }),
  false
);
assert.equal(
  isShrunkParse({ storedDurationSec: 3480, nextDurationSec: 3480, sourceChanged: false }),
  false
);
/* Same total duration with a different segment cut (re-segmentation). */
assert.equal(
  isShrunkParse({ storedDurationSec: 3480, nextDurationSec: 3479, sourceChanged: false }),
  false
);
/* A different source may legitimately be a different length. */
assert.equal(
  isShrunkParse({ storedDurationSec: 3480, nextDurationSec: 1000, sourceChanged: true }),
  false
);
/* Nothing stored yet (fresh start) can't shrink. */
assert.equal(
  isShrunkParse({ storedDurationSec: 0, nextDurationSec: 100, sourceChanged: false }),
  false
);
/* A durationless parse against a stored one is garbage, not a re-cut. */
assert.equal(
  isShrunkParse({ storedDurationSec: 100, nextDurationSec: 0, sourceChanged: false }),
  true
);

/* Piece URLs classify into wipe groups; record-level and legacy pieces are
 * kept (playlists rewrite every attempt, legacy is content-addressed). */
assert.deepEqual(pieceInfo(segmentIndexUrl("e:1:1:1", "v", 4)), {
  group: "video",
  role: "v",
  isSegment: true,
});
assert.deepEqual(pieceInfo(segmentIndexUrl("e:1:1:1", "vi", 0)), {
  group: "video",
  role: "vi",
  isSegment: false,
});
assert.deepEqual(pieceInfo(segmentIndexUrl("e:1:1:1", "ak", 7)), {
  group: "audio",
  role: "ak",
  isSegment: false,
});
assert.deepEqual(pieceInfo(segmentIndexUrl("e:1:1:1", "s", 9)), {
  group: "subs",
  role: "s",
  isSegment: true,
});
assert.equal(pieceInfo(dlPlaylistUrl("e:1:1:1")), null);
assert.equal(pieceInfo(segmentIndexUrl("e:1:1:1", "vp", 0)), null);
assert.equal(
  pieceInfo(offlinePieceUrl("https://cdn.example.com/a.ts")),
  null
);

// Episode-still thumbs: w300 16:9 cut, null-safe, and the cacher degrades
// gracefully where Cache Storage doesn't exist (node).
assert.equal(
  stillThumbUrl("/abc123.jpg"),
  "https://image.tmdb.org/t/p/w300/abc123.jpg"
);
assert.equal(stillThumbUrl(null), null);
assert.equal(stillThumbUrl(undefined), null);
assert.equal(stillThumbUrl(""), null);
void (async () => {
  assert.equal(await cacheStillThumb("/abc123.jpg"), false);
  assert.equal(await cacheStillThumb(null), false);
  console.log("offline download checks ok");
})();
