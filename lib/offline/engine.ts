/**
 * Offline download engine (page context).
 *
 * Flow per item: resolve native playlist (vidsrc-sh → vidsrc-pm → vix
 * cascade — iframe sources can never download, the browser never touches
 * their bytes) →
 * pick variant at/below the quality setting → fetch segments + init + keys
 * through the same same-origin paths the player uses → store bytes in the
 * `tvtime-downloads` cache under `/api/dl?u=` keys → store the rewritten
 * playlist under `/api/dl?playlist=` → auto-fetch the subtitle track →
 * mark done. Pause/resume/cancel via per-key AbortControllers; resume
 * skips bytes already in the cache.
 */

import {
  resolveStreamPlaylist,
  type StreamResolveResult,
} from "@/lib/player-stream";
import type { StreamSource } from "@/lib/player-native-types";
import { fetchExternalVtt, type SubFileId } from "@/lib/player-subs";
import { fetchSegments } from "@/lib/introdb";
import { loadVixSettings, matchLang } from "@/lib/vix-settings";
import {
  DL_CACHE,
  cachePosterThumb,
  cacheStillThumb,
  checkpointRecord,
  commitRecord,
  deleteRecordFiles,
  downloadKey,
  ensurePersisted,
  flushManifest,
  getAllSync,
  getManifest,
  getManifestStrict,
  getRecordSync,
  isPlaybackInUse,
  removeRecord,
  storageStats,
  updateProgress,
  upsertRecord,
  usedBytes,
  type DownloadRecord,
} from "@/lib/offline/store";
import {
  buildOfflineMaster,
  classifyPieceStatus,
  dlPlaylistUrl,
  estimateBytes,
  gapBudget,
  indexRetryAction,
  isHardDownloadError,
  isMasterPlaylist,
  minVariantHeight,
  offlinePieceUrl,
  parseMasterAudio,
  parseMasterSubtitles,
  parseMasterVariants,
  parseMediaPlaylist,
  pickAudioEntry,
  pickVariant,
  rewritePlaylistToIndexUrls,
  segmentIndexUrl,
  segmentShouldReject,
  sliceToRange,
  withEndlist,
  withOfflineSubtitles,
  type AudioEntry,
  type ByteRange,
  type MediaParts,
  type PieceFailureReason,
  type SubEntry,
  type VariantInfo,
} from "@/lib/offline/hls";
import {
  PINNED_CONFIRM_DELAYS_MS,
  downloadCandidates,
  mirrorIdentity,
  needsGiveWayConfirm,
  pinnedDownloadSource,
  pinnedResolveGivesWay,
} from "@/lib/offline/candidates";
import {
  encodeRendition,
  isShrunkParse,
  pieceInfo,
  planRenditionWipe,
} from "@/lib/offline/rendition";
import { formatBytes } from "@/lib/utils";

export type DownloadRequest = {
  type: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  title: string;
  subtitle?: string;
  /** TMDB poster path — lets the Library show a thumbnail while offline. */
  poster?: string | null;
};

const CONCURRENCY = 4;

const activeControllers = new Map<string, AbortController>();
const pauseIntents = new Set<string>();
const cancelIntents = new Set<string>();
/**
 * In-flight start guard: two concurrent startDownload(same key) calls both
 * pass the queued/active checks before either registers a controller. The
 * Set is touched synchronously at entry so the race window is closed;
 * cross-tab duplicates still rely on the ownedHere handoff below.
 */
const startingKeys = new Set<string>();

const iosQueue: DownloadRequest[] = [];
/** Background lock/tab-hide. Distinct from a manual pause so we auto-continue. */
const systemPauseKeys = new Set<string>();
const autoResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Synchronous guard so a timer and a visibility event can't both continue one row. */
const continueLocks = new Set<string>();

export function isDownloadActive(key: string): boolean {
  return activeControllers.has(key);
}

function requestKey(req: DownloadRequest): string {
  return downloadKey(
    req.type === "movie" ? "movie" : "episode",
    req.tmdbId,
    req.season,
    req.episode
  );
}

export function isDownloadQueued(key: string): boolean {
  return iosQueue.some((r) => requestKey(r) === key);
}

function dequeueIos(key: string): void {
  const next = iosQueue.filter((r) => requestKey(r) !== key);
  iosQueue.splice(0, iosQueue.length, ...next);
}

function otherSlotTaken(key: string): boolean {
  for (const k of activeControllers.keys()) if (k !== key) return true;
  for (const k of startingKeys) if (k !== key) return true;
  return false;
}

function clearAutoResume(key: string): void {
  const t = autoResumeTimers.get(key);
  if (t != null) clearTimeout(t);
  autoResumeTimers.delete(key);
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/**
 * A piece failed after the retries that apply to its reason.
 * `network` keeps every finished segment and is continued automatically.
 * `auth` means the link expired — refresh the playlist, never punch a gap.
 * `dead` is a bad segment (gap it, or leave the mirror if the cap is hit).
 * `quota` is a hard stop.
 */
class PieceDownloadError extends Error {
  reason: PieceFailureReason;
  constructor(message: string, reason: PieceFailureReason) {
    super(message);
    this.name = "PieceDownloadError";
    this.reason = reason;
  }
}

/** Expired playlist/segment URL. The mirror loop refreshes once and retries. */
class AuthRefresh extends Error {
  constructor() {
    super("auth refresh");
    this.name = "AuthRefresh";
  }
}

/** Sibling workers were stopped on purpose. Not a user pause and not a failure. */
class PoolStopped extends Error {
  constructor() {
    super("pool stopped");
    this.name = "PoolStopped";
  }
}

/** Per-piece network ceiling: a hung connection must fail, never freeze. */
const PIECE_TIMEOUT_MS = 30000;
/** No completed piece for this long with work remaining = stalled. */
const STALL_TIMEOUT_MS = 60000;
const RETRY_TRIES = 5;
const RETRY_BASE_MS = 800;
const AUTO_ATTEMPT_CAP = 5;
/** Downloads finished this recently are LRU victims only as a last resort. */
const RECENT_USE_FLOOR_MS = 10 * 60_000;

/** WebKit Cache Storage corrupts under parallel puts. One writer at a time. */
let cacheChain: Promise<void> = Promise.resolve();
function enqueueCache<T>(fn: () => Promise<T>): Promise<T> {
  const run = cacheChain.then(fn, fn);
  cacheChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iP(hone|ad|od)/.test(ua)) return true;
  // iPadOS reports itself as Macintosh.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function pieceConcurrency(): number {
  return isIosSafari() ? 2 : CONCURRENCY;
}

/**
 * AbortSignal.any is missing on iOS 16 and some webviews. Listeners are
 * removed when the composed operation finishes.
 */
function linkSignals(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (ss: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(signals);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of signals) {
    if (s.aborted) controller.abort();
    else s.addEventListener("abort", onAbort);
  }
  return controller.signal;
}

async function withSignals<T>(
  signals: AbortSignal[],
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const anyFn = (AbortSignal as unknown as { any?: (ss: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return run(anyFn(signals));
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of signals) {
    if (s.aborted) controller.abort();
    else s.addEventListener("abort", onAbort);
  }
  try {
    return await run(controller.signal);
  } finally {
    for (const s of signals) s.removeEventListener("abort", onAbort);
  }
}

/**
 * Parse Retry-After (seconds or HTTP-date) → milliseconds, or null.
 * Local copy (client-safe): mirrors lib/stream-proxy for the offline engine.
 */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const h = header.trim();
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 120) return n * 1000;
    return null;
  }
  const t = Date.parse(h);
  if (!Number.isNaN(t)) {
    const diff = t - Date.now();
    if (diff >= 0 && diff <= 120_000) return diff;
  }
  return null;
}

/** Abort-aware wait. Resolves on timeout, rejects if the user signal aborts. */
function waitBackoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    if (signal.aborted) {
      clearTimeout(t);
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter != null) return retryAfter;
  return Math.min(RETRY_BASE_MS * 2 ** attempt, 8000) + Math.random() * 400;
}

/**
 * Fetch one piece. Timeouts and connection resets throw PieceDownloadError
 * (`network`) — they are never a user pause. `pool` abort throws PoolStopped
 * so a sibling can stop the group without failing the title.
 * Status 200 is a full body. A requested byte range may be 206 or a 200
 * that the caller slices. Any other 206 is a partial and must not be stored.
 */
async function fetchPiece(
  input: string,
  userSignal: AbortSignal,
  poolSignal: AbortSignal | null,
  range: ByteRange | null
): Promise<Response> {
  const timeout = AbortSignal.timeout(PIECE_TIMEOUT_MS);
  const signals = [userSignal, timeout];
  if (poolSignal) signals.push(poolSignal);
  const headers: Record<string, string> = {};
  if (range) {
    headers.Range = `bytes=${range.start}-${range.start + range.length - 1}`;
  }
  try {
    return await withSignals(signals, (signal) =>
      fetch(input, { signal, headers })
    );
  } catch (err) {
    if (userSignal.aborted) throw abortError();
    if (poolSignal?.aborted) throw new PoolStopped();
    if (timeout.aborted || (err instanceof Error && err.name === "TimeoutError")) {
      throw new PieceDownloadError("A piece stalled — tap to retry", "network");
    }
    if (
      err instanceof TypeError ||
      (err instanceof Error && /failed to fetch|network/i.test(err.message))
    ) {
      throw new PieceDownloadError("Connection dropped — tap to retry", "network");
    }
    throw err;
  }
}

/**
 * Size of one segment without downloading it: a 1-byte Range probe reads
 * the total from Content-Range (206) or Content-Length (200, when the
 * server ignores Range — the body is cancelled unread). Returns 0 when
 * neither is available; a user abort still propagates.
 */
async function probeSegmentBytes(url: string, signal: AbortSignal): Promise<number> {
  try {
    const res = await fetchPiece(url, signal, null, { start: 0, length: 1 });
    let total = 0;
    const cr = res.headers.get("content-range");
    const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
    if (m) total = Number(m[1]);
    if (!total && res.status === 200) {
      const n = Number(res.headers.get("content-length") || 0);
      if (Number.isFinite(n) && n > 0) total = n;
    }
    await res.body?.cancel();
    return total;
  } catch (err) {
    if (signal.aborted) throw err;
    return 0;
  }
}

/**
 * Total bytes for one rendition from real segment sizes: byterange
 * playlists carry exact lengths in the playlist itself (no requests);
 * otherwise sample ~5 segments spread across the stream and extrapolate.
 * Non-fatal — 0 keeps the bandwidth/quality-guess seed for reportProgress.
 */
async function scanPartBytes(list: MediaParts, signal: AbortSignal): Promise<number> {
  const segs = list.segments;
  if (segs.length === 0) return 0;
  if (segs.every((s) => s.byteRange)) {
    return segs.reduce((n, s) => n + (s.byteRange?.length ?? 0), 0);
  }
  const n = segs.length;
  const picks = new Set<number>();
  for (let k = 0; k < 5; k++) picks.add(Math.floor((k * (n - 1)) / 4));
  // The tail segment is a short remainder — including it skews the mean low.
  if (n > 8) picks.delete(n - 1);
  const sizes = (
    await Promise.all([...picks].map((i) => probeSegmentBytes(segs[i]!.url, signal)))
  ).filter((b) => b > 0);
  if (sizes.length === 0) return 0;
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  return Math.round(avg * n);
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown };
    if (typeof data?.error === "string" && data.error.length > 0) {
      return data.error.slice(0, 120);
    }
  } catch {
    /* binary body */
  }
  return "";
}

/**
 * Bounded retries for network failures only (timeout, reset, 429, 5xx).
 * 401/403 throw immediately so the caller can refresh the playlist.
 * 404 throws immediately so the caller can gap that one segment.
 */
async function fetchPieceRetry(
  input: string,
  userSignal: AbortSignal,
  poolSignal: AbortSignal | null,
  range: ByteRange | null,
  tries = RETRY_TRIES
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (userSignal.aborted) throw abortError();
    if (poolSignal?.aborted) throw new PoolStopped();
    let res: Response;
    try {
      res = await fetchPiece(input, userSignal, poolSignal, range);
    } catch (err) {
      if (userSignal.aborted || err instanceof PoolStopped) throw err;
      if (
        err instanceof PieceDownloadError &&
        err.reason === "network" &&
        attempt + 1 < tries
      ) {
        await waitBackoff(backoffMs(attempt, null), userSignal);
        continue;
      }
      throw err;
    }
    const rangedOk = range != null && (res.status === 200 || res.status === 206);
    if ((range == null && res.status === 200) || rangedOk) return res;
    const detail = await readErrorDetail(res);
    try {
      await res.arrayBuffer();
    } catch {
      /* already drained or empty */
    }
    const reason = classifyPieceStatus(res.status, detail);
    const err = new PieceDownloadError(
      detail ? `failed (${res.status}: ${detail})` : `failed (${res.status}).`,
      reason
    );
    if (reason === "network" && attempt + 1 < tries) {
      await waitBackoff(
        backoffMs(attempt, retryAfterMs(res.headers.get("retry-after"))),
        userSignal
      );
      continue;
    }
    throw err;
  }
}

/**
 * Turn a failed native resolution into an honest message. The generic
 * "no downloadable stream" hid the real cause: on Vercel-class hosting the
 * sources block direct requests, so without the standalone resolver
 * (VIX_RESOLVER_URL) there is no native path at all — while iframe
 * playback keeps working, which made the old message look like a lie.
 * Downloads now walk a candidate list, so every message carries the trail
 * of sources that were tried (`attempts`).
 */
function diagnoseResolveFailure(r: {
  code?: string;
  detail?: string;
  attempts?: Array<{ source: string; ok: boolean; error?: string }>;
}): string {
  const tried = (r.attempts ?? [])
    .filter((a) => !a.ok)
    .map((a) => (a.error ? `${a.source} (${a.error})` : a.source))
    .join(", ");
  const trail = tried ? ` Tried: ${tried}.` : "";
  if (r.code === "resolver_unconfigured") {
    return `Downloads need the stream resolver — VIX_RESOLVER_URL isn't set on this deployment, and the sources block it directly. Streaming still works via embeds, but offline needs native. Set the env var and redeploy.${trail}`;
  }
  if (r.code === "resolution_failed") {
    return `Stream resolver failed${r.detail ? ` (${r.detail})` : ""} If it names the resolver, revive/redeploy that service (its /health should return ok), check VIX_RESOLVER_URL, then retry.${trail}`;
  }
  if (r.code === "upstream_unreachable") {
    return `Sources are unreachable from this deployment right now.${trail} Retry in a bit — embed streaming is unaffected.`;
  }
  return `No downloadable stream${tried ? ` (tried: ${tried})` : ""} — the title may only exist on embed sources right now.`;
}

export async function startDownload(
  req: DownloadRequest,
  opts?: { auto?: boolean }
): Promise<void> {
  const settings = loadVixSettings();
  if (!settings.downloadMode) {
    throw new Error("Download mode is off — enable it in Download settings.");
  }
  const key = downloadKey(
    req.type === "movie" ? "movie" : "episode",
    req.tmdbId,
    req.season,
    req.episode
  );
  // Synchronous duplicate-start guard (see startingKeys).
  if (startingKeys.has(key)) return;
  startingKeys.add(key);
  try {
    return await runExclusive(key, () =>
      startDownloadInner(req, key, opts?.auto ?? false)
    );
  } finally {
    startingKeys.delete(key);
    pumpQueue();
  }
}

/**
 * Cross-tab run fence. Two contexts (e.g. an auto-resume timer in each tab)
 * used to run the same key simultaneously: double bandwidth, and both wrote
 * progress for one row. `ifAvailable` never queues — when another tab holds
 * the key we hand off silently; its run owns the row. No Web Locks API
 * (tests, old engines) falls back to the same-tab-only fencing above.
 */
async function runExclusive(key: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  await locks.request(`tvtime-download:${key}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return; // another tab owns this key — hands off
    await fn();
  });
}

/**
 * Consume a delete/cancel intent for `key` and remove whatever row remains.
 * Every path that starts (or finishes) a run shares this so the intent can
 * never be half-consumed: whichever check sees it first does the full
 * cleanup — files, record, iOS queue slot, auto-resume timer.
 */
async function consumeCancel(key: string, fallback: DownloadRecord | null): Promise<void> {
  cancelIntents.delete(key);
  pauseIntents.delete(key);
  clearAutoResume(key);
  dequeueIos(key);
  systemPauseKeys.delete(key);
  const live = getRecordSync(key) ?? fallback;
  if (live) {
    await deleteRecordFiles(live);
    await removeRecord(key);
  }
}

async function startDownloadInner(
  req: DownloadRequest,
  key: string,
  auto: boolean
): Promise<void> {
  const settings = loadVixSettings();
  if (!settings.downloadMode) {
    throw new Error("Download mode is off — enable it in Download settings.");
  }
  // Read the row BEFORE touching intents: the cancel decision below needs
  // to know whether one exists, and a failed manifest read must abort the
  // start (getManifestStrict) instead of handing back `{}` — that throwaway
  // object used to look like "no record" and silently rebuild the row at 0%.
  const existing = getRecordSync(key) ?? (await getManifestStrict())[key];
  // A delete/cancel aimed at a start that never materialised is consumed
  // here. Auto continuations honour it — this is the resurrection fix (a
  // stale queued/active row re-upserted by continueAutomatic would run
  // again). A manual tap is the user's latest word and clears it instead,
  // so the first download after a delete doesn't no-op.
  if (cancelIntents.has(key)) {
    if (auto) {
      await consumeCancel(key, existing);
      return;
    }
    cancelIntents.delete(key);
  }
  // A pause from a run that never materialised must not pause THIS attempt.
  pauseIntents.delete(key);
  // A live loop in this instance owns the key — hands off.
  if (activeControllers.has(key)) return;
  // NOTE: no early return for `queued`/`active` rows without a controller.
  // Those are stale takeovers (a resume intent that just queued the row, an
  // HMR reset, a lost map entry): fall through and adopt the row instead of
  // stranding it forever. A rival loop in another tab is still fenced by the
  // ownedHere handoff in the catch/finally below.

  const now = Date.now();
  // Quality switch orphans prior bytes (segment URLs differ): drop the old
  // files and restart counters instead of leaking unreferenced cache entries.
  const sameQuality = (existing?.quality ?? settings.downloadQuality) === settings.downloadQuality;
  if (
    existing &&
    !sameQuality &&
    (existing.fileUrls.length > 0 || existing.doneSegments > 0 || existing.bytesDone > 0)
  ) {
    // Logged like the rendition wipe — a silent restart is undiagnosable.
    console.warn("[downloads] quality change — wiping progress", {
      key,
      from: existing.quality,
      to: settings.downloadQuality,
      bytes: existing.bytesDone,
    });
    await deleteRecordFiles(existing);
  }
  const rec: DownloadRecord = {
    key,
    type: req.type === "movie" ? "movie" : "episode",
    tmdbId: req.tmdbId,
    season: req.season,
    episode: req.episode,
    title: req.title,
    subtitle: req.subtitle,
    posterPath: req.poster ?? existing?.posterPath ?? null,
    stillPath: existing?.stillPath ?? null,
    quality: settings.downloadQuality,
    usedSource: existing?.usedSource ?? "",
    durationSec: existing?.durationSec ?? 0,
    // A quality switch buys a fresh estimate — the old one described the old
    // variant and (with estimates now surviving attempts) would never reseed.
    estimateBytes: sameQuality ? (existing?.estimateBytes ?? 0) : 0,
    sizeBytes: 0,
    // Resume seeds the bar where the last run left off (capped at known
    // totals) instead of visibly restarting at 0%. Verification still runs
    // over every piece, so evicted bytes re-download and the final counts
    // stay honest. A quality switch restarts from zero (see above).
    bytesDone: sameQuality
      ? Math.min(
          existing?.bytesDone ?? 0,
          existing?.estimateBytes || Number.POSITIVE_INFINITY
        )
      : 0,
    totalSegments: sameQuality ? (existing?.totalSegments ?? 0) : 0,
    doneSegments: sameQuality
      ? Math.min(
          existing?.doneSegments ?? 0,
          existing?.totalSegments || Number.POSITIVE_INFINITY
        )
      : 0,
    // Same quality resumes against existing cache entries (verified per
    // piece below); a switch starts with no owned files.
    fileUrls: sameQuality ? [...(existing?.fileUrls ?? [])] : [],
    state: "queued",
    error: undefined,
    subVtt: existing?.subVtt ?? null,
    subLabel: existing?.subLabel ?? null,
    subAlts: existing?.subAlts ?? [],
    segments: existing?.segments ?? null,
    downloadedAt: 0,
    lastUsedAt: now,
    retryable: existing?.retryable,
    autoAttempts: existing?.autoAttempts ?? 0,
    interruptedOffline: existing?.interruptedOffline,
    rendition: sameQuality ? existing?.rendition : undefined,
    usedPlaylistUrl: sameQuality ? existing?.usedPlaylistUrl : undefined,
  };
  // Player downloads carry no artwork, and rows from before thumbnails
  // existed have none either. Resolve it here — we are provably online —
  // then cache the tiny images below so the Library opens with art even
  // after the connection is gone. Episodes resolve their still (16:9 tile);
  // the series poster stays as the fallback wherever the still is missing.
  if (!rec.posterPath || (req.type !== "movie" && !rec.stillPath)) {
    const art = await lookupArtwork(
      req.type === "movie" ? "movie" : "tv",
      req.tmdbId,
      req.season,
      req.episode
    );
    if (!rec.posterPath) rec.posterPath = art.posterPath;
    if (!rec.stillPath) rec.stillPath = art.stillPath;
  }
  // A delete landed while we resolved the poster (no controller yet, so it
  // couldn't abort us): honour it now, before anything is upserted under it.
  if (cancelIntents.has(key)) {
    await consumeCancel(key, existing);
    return;
  }
  // iPhone can't run two titles at once without getting the tab killed.
  if (isIosSafari() && otherSlotTaken(key)) {
    if (!iosQueue.some((r) => requestKey(r) === key)) iosQueue.push(req);
    rec.state = "queued";
    await upsertRecord(rec);
    // Same window after the queued upsert: don't leave a row the delete
    // already revoked sitting in the manifest (or in the iOS queue).
    if (cancelIntents.has(key)) {
      await consumeCancel(key, rec);
    }
    return;
  }
  await upsertRecord(rec);
  // Kick the thumbnail fetches immediately — we are online right now and
  // the Library must open with art even after the connection is gone.
  void cachePosterThumb(rec.posterPath);
  void cacheStillThumb(rec.stillPath);

  const controller = new AbortController();
  activeControllers.set(key, controller);
  try {
    // Pause/cancel can land between the queued upsert and this attach — no
    // controller existed yet, so they acted durably (or left an intent for
    // us). Re-read before running: runDownload's `active` flip must not
    // overwrite a pause from that window, and a cancel must not be
    // resurrected by the first checkpoint.
    const pre = getRecordSync(key) ?? (await getManifest())[key];
    if (cancelIntents.has(key) || !pre) {
      await consumeCancel(key, pre);
      return;
    }
    if (pauseIntents.has(key) || pre.state === "paused") {
      pauseIntents.delete(key);
      if (pre.state !== "done" && pre.state !== "paused") {
        await commitRecord({ ...pre, state: "paused", error: undefined, retryable: false });
      }
      return;
    }
    await runDownload(req, rec, controller.signal);
    // A delete landing during the final commit must still win: the row
    // (possibly re-upserted after the delete's removeRecord) goes away now,
    // not as a resurrected "done" row.
    if (cancelIntents.has(key)) {
      await consumeCancel(key, rec);
      return;
    }
  } catch (err) {
    // Stop straggler workers still burning data after the first failure.
    // (Pause/cancel paths already aborted; this is a no-op for them.)
    controller.abort();
    const cancelled = controller.signal.aborted;
    // Identity, not just presence: another tab/session may have registered
    // its own controller under this key after ours died.
    const ownedHere = activeControllers.get(key) === controller;
    if (cancelIntents.has(key)) {
      await consumeCancel(key, rec);
      return;
    }
    const live = getRecordSync(key) ?? (await getManifest())[key];
    // Deleted or finished elsewhere — never resurrect or clobber.
    if (!live || live.state === "done") return;
    const system = systemPauseKeys.has(key);
    systemPauseKeys.delete(key);
    if (live.state === "paused" || system || (ownedHere && cancelled && pauseIntents.has(key))) {
      pauseIntents.delete(key);
      await commitRecord({
        ...rec,
        state: "paused",
        error: undefined,
        // Manual pause stays put. Lock-screen / tab-hide continues on return.
        retryable: system ? true : false,
      });
      return;
    }
    // Another live loop owns this key now — hands off, don't clobber it.
    if (!ownedHere) return;
    const offline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    const message = err instanceof Error ? err.message : "Download failed";
    const quota = err instanceof PieceDownloadError && err.reason === "quota";
    const hard = quota || isHardDownloadError(message);
    await commitRecord({
      ...rec,
      state: "error",
      error: message,
      retryable: !hard,
      interruptedOffline: offline || undefined,
    });
    if (!hard) scheduleAutoResume(req);
  } finally {
    if (activeControllers.get(key) === controller) activeControllers.delete(key);
  }
}

/**
 * Pause a download. Always lands: aborts the live controller when this
 * instance owns one, and otherwise flips durable state directly so the row
 * can't strand in "active" (second tab, HMR module reset, lost map entry).
 */
export async function pauseDownload(key: string): Promise<void> {
  clearAutoResume(key);
  systemPauseKeys.delete(key);
  dequeueIos(key);
  pauseIntents.add(key);
  const controller = activeControllers.get(key);
  if (controller) {
    controller.abort();
    return; // consumed by the run's catch path
  }
  const rec = getRecordSync(key) ?? (await getManifest())[key];
  if (rec && (rec.state === "active" || rec.state === "queued")) {
    pauseIntents.delete(key);
    await commitRecord({ ...rec, state: "paused", error: undefined, retryable: false });
  }
  // Otherwise the row is still being created, already paused, in error, or
  // gone: keep the intent — startDownload's attach re-check consumes it
  // (this used to be deleted unconditionally, silently dropping pauses
  // issued while a run was still attaching). Stale copies are cleared when
  // the next start enters startDownloadInner.
}

export async function resumeDownload(req: DownloadRequest): Promise<void> {
  const key = requestKey(req);
  // Manual retry: a fresh budget, and it must not sit behind the auto timer.
  clearAutoResume(key);
  pauseIntents.delete(key);
  systemPauseKeys.delete(key);
  dequeueIos(key);
  const rec = getRecordSync(key) ?? (await getManifest())[key];
  if (rec && rec.state !== "done") {
    await upsertRecord({
      ...rec,
      state: "queued",
      error: undefined,
      retryable: false,
      autoAttempts: 0,
    });
  }
  return startDownload(req);
}

/**
 * Re-run a finished download as a cache-hit pass: stored indexes verify
 * against the cache (only evicted ones refetch) and the `rec.missing`
 * holes come off the network. Cheap — used by the "Partial" repair action.
 */
export async function repairDownload(key: string): Promise<void> {
  const rec = getRecordSync(key) ?? (await getManifest())[key];
  if (!rec || rec.state !== "done") return;
  return startDownload(reqFromRecord(rec));
}

/** Poster (+ episode still) paths from our own API — never a browser TMDB key. */
async function lookupArtwork(
  type: "movie" | "tv",
  tmdbId: number,
  season?: number,
  episode?: number
): Promise<{ posterPath: string | null; stillPath: string | null }> {
  try {
    const q = new URLSearchParams({ type, id: String(tmdbId) });
    if (season != null) q.set("season", String(season));
    if (episode != null) q.set("episode", String(episode));
    const res = await fetch(`/api/meta/poster?${q.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return { posterPath: null, stillPath: null };
    const data = (await res.json()) as {
      posterPath?: string | null;
      stillPath?: string | null;
    };
    return {
      posterPath: data.posterPath ?? null,
      stillPath: data.stillPath ?? null,
    };
  } catch {
    return { posterPath: null, stillPath: null };
  }
}

function reqFromRecord(rec: DownloadRecord): DownloadRequest {
  return {
    type: rec.type === "movie" ? "movie" : "tv",
    tmdbId: rec.tmdbId,
    season: rec.season,
    episode: rec.episode,
    title: rec.title,
    subtitle: rec.subtitle,
    poster: rec.posterPath,
  };
}

function eligibleToContinue(rec: DownloadRecord): boolean {
  if (rec.state === "done" || rec.state === "missing") return false;
  if (rec.state === "active" || rec.state === "queued") return true;
  return (rec.state === "paused" || rec.state === "error") && !!rec.retryable;
}

/** Continue one interrupted row. Does not reset the automatic-attempt budget. */
async function continueAutomatic(rec: DownloadRecord): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (continueLocks.has(rec.key) || activeControllers.has(rec.key) || startingKeys.has(rec.key)) {
    return;
  }
  if (isDownloadQueued(rec.key)) return;
  if (!eligibleToContinue(rec)) return;
  if (rec.state === "error" && (rec.autoAttempts ?? 0) >= AUTO_ATTEMPT_CAP) return;
  // Deleted while we were deciding: don't re-upsert the row — that write
  // was the resurrection (startDownload's entry check consumes the intent
  // and cleans up, but skipping here avoids flashing the row back first).
  if (cancelIntents.has(rec.key)) return;
  continueLocks.add(rec.key);
  try {
    const nextAttempts =
      rec.state === "error" ? (rec.autoAttempts ?? 0) + 1 : (rec.autoAttempts ?? 0);
    await upsertRecord({
      ...rec,
      state: "queued",
      error: undefined,
      retryable: true,
      autoAttempts: nextAttempts,
    });
    await startDownload(reqFromRecord(rec), { auto: true });
  } finally {
    continueLocks.delete(rec.key);
  }
}

async function continueNextEligible(): Promise<void> {
  if (typeof document !== "undefined" && document.hidden) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (activeControllers.size > 0 || startingKeys.size > 0) return;
  const all = Object.values(await getManifest());
  for (const rec of all) {
    if (autoResumeTimers.has(rec.key) || isDownloadQueued(rec.key)) continue;
    if (!eligibleToContinue(rec)) continue;
    if (rec.state === "error" && (rec.autoAttempts ?? 0) >= AUTO_ATTEMPT_CAP) continue;
    try {
      await continueAutomatic(rec);
    } catch {
      /* the row is already marked; the next visible/online pass retries */
    }
    return;
  }
}

function scheduleAutoResume(req: DownloadRequest): void {
  const key = requestKey(req);
  if (autoResumeTimers.has(key)) return;
  const attempts = getRecordSync(key)?.autoAttempts ?? 0;
  if (attempts >= AUTO_ATTEMPT_CAP) return;
  const delay = Math.min(4000 * 2 ** attempts, 30_000);
  const timer = setTimeout(() => {
    autoResumeTimers.delete(key);
    const rec = getRecordSync(key);
    if (!rec || rec.state === "done") return;
    void continueAutomatic(rec).catch(() => {
      /* next pass */
    });
  }, delay);
  autoResumeTimers.set(key, timer);
}

function pumpQueue(): void {
  if (typeof document !== "undefined" && document.hidden) return;
  if (activeControllers.size > 0 || startingKeys.size > 0) return;
  if (isIosSafari() && iosQueue.length > 0) {
    const next = iosQueue.shift();
    if (next) {
      void startDownload(next, { auto: true }).catch(() => {
        /* next queue pass */
      });
      return;
    }
  }
  void continueNextEligible();
}

/** Page is still open (in-app navigation, app switcher). Do not abort. */
function checkpointOnHide(): void {
  flushManifest();
}

let autoRetryInit = false;
let kickLock = false;

/**
 * Continue downloads that were interrupted (stall, expired link, lock screen,
 * killed tab). A manual pause is not resumed. Idempotent.
 */
export function initDownloadAutoRetry(): void {
  if (autoRetryInit || typeof window === "undefined") return;
  autoRetryInit = true;
  const onVisible = () => {
    if (document.hidden || kickLock) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    kickLock = true;
    void (async () => {
      try {
        if (
          isIosSafari() &&
          iosQueue.length > 0 &&
          activeControllers.size === 0 &&
          startingKeys.size === 0
        ) {
          const next = iosQueue.shift();
          if (next) {
            await startDownload(next, { auto: true });
            return;
          }
        }
        await continueNextEligible();
      } catch {
        /* next pass */
      } finally {
        kickLock = false;
      }
    })();
  };
  window.addEventListener("online", onVisible);
  window.addEventListener("pageshow", onVisible);
  window.addEventListener("pagehide", checkpointOnHide);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) checkpointOnHide();
    else onVisible();
  });
}

export function cancelDownload(key: string) {
  clearAutoResume(key);
  dequeueIos(key);
  systemPauseKeys.delete(key);
  if (!activeControllers.has(key)) {
    // Not running — just drop the row + files. Leave the intent set too:
    // when this key is mid-attach (no controller registered yet), the
    // startDownload re-check consumes it instead of resurrecting the row
    // after the durable delete; the entry-clear of the next start sweeps
    // any intent whose run never materialised.
    cancelIntents.add(key);
    void (async () => {
      const rec = getRecordSync(key);
      if (rec) await deleteRecordFiles(rec);
      await removeRecord(key);
    })();
    return;
  }
  cancelIntents.add(key);
  pauseIntents.delete(key);
  activeControllers.get(key)?.abort();
}

export async function deleteDownload(key: string): Promise<void> {
  // Set the intent BEFORE anything async: a start mid-attach (poster await,
  // no controller yet) must see it instead of re-upserting the row after our
  // removeRecord. The intent stays set until that start consumes it —
  // clearing it here would reopen the race; a leftover without a start is
  // swept by the next start's entry check (auto honours, manual clears).
  cancelIntents.add(key);
  clearAutoResume(key);
  dequeueIos(key);
  systemPauseKeys.delete(key);
  pauseIntents.delete(key);
  activeControllers.get(key)?.abort();
  activeControllers.delete(key);
  const rec = getRecordSync(key);
  if (rec) await deleteRecordFiles(rec);
  await removeRecord(key);
}

/** Sleep that rejects with the run's abort error if the signal fires. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function runDownload(
  req: DownloadRequest,
  rec: DownloadRecord,
  signal: AbortSignal
): Promise<void> {
  const throwIfAborted = () => {
    if (signal.aborted) throw abortError();
  };

  rec.state = "active";
  await upsertRecord(rec);
  // Source this run started on: the cascade below may resolve another one,
  // and a source change means every stored piece belongs to a different
  // copy of the title (the rendition guard distrusts all of them).
  const prevSource = rec.usedSource;

  // 1. Resolve a native playlist from a FIXED cascade — vidsrc-sh →
  //    vidsrc-pm → vix, first hit wins. Downloads no longer consult the
  //    player's preferredSource: the player rewrites that on every
  //    hand-picked source switch, which silently reordered downloads
  //    between runs — and resolving a different source than the previous
  //    run is a different cut of the video, which the rendition guard
  //    below wipes. goated is parked (backend NXDOMAIN since 2026-09-23 —
  //    see lib/goated.ts), so it is never a candidate, and an embed
  //    preference can never download anyway. A run that already owns bytes
  //    pins its last working source FIRST, and that pin only gives way on a
  //    permanent-for-title verdict (see pinnedResolveGivesWay) — a
  //    transient blip stops the cascade so the auto-retry re-pins instead
  //    of flipping to another cut mid-title.
  const hasProgress = rec.doneSegments > 0 || rec.bytesDone > 0;
  const pinned = pinnedDownloadSource(rec.usedSource, hasProgress);
  const candidates = downloadCandidates(pinned);
  const failures: Array<{
    source: string;
    code?: string;
    detail?: string;
    error?: string;
  }> = [];
  let resolved: StreamResolveResult | null = null;
  let source: StreamSource = candidates[0]!;
  let pinnedTransient: { source: string; code?: string } | null = null;
  for (const candidate of candidates) {
    const doResolve = () =>
      resolveStreamPlaylist({
        source: candidate,
        type: req.type,
        tmdbId: req.tmdbId,
        season: req.season,
        episode: req.episode,
        signal,
      });
    let r = await doResolve();
    throwIfAborted();
    if (
      !r.playlistUrl &&
      needsGiveWayConfirm(hasProgress, candidate, pinned, r.code)
    ) {
      // Case 3: the pinned source owns stored bytes and just reported a
      // "permanent" verdict. Re-check it — not_found/no_streams also come
      // from transient upstream 404s/empty responses, and giving way flips
      // usedSource, which wipes the whole title as a different cut. A check
      // that turns transient aborts the give-way entirely (handled below).
      for (const delayMs of PINNED_CONFIRM_DELAYS_MS) {
        await abortableDelay(delayMs, signal);
        r = await doResolve();
        throwIfAborted();
        if (r.playlistUrl || !pinnedResolveGivesWay(r.code)) break;
      }
      if (r.playlistUrl) {
        resolved = r;
        source = candidate;
        break;
      }
    }
    if (r.playlistUrl) {
      resolved = r;
      source = candidate;
      break;
    }
    failures.push({
      source: candidate,
      code: r.code,
      detail: r.detail,
      error: r.errorMessage ?? r.detail ?? r.code,
    });
    if (candidate === pinned && !pinnedResolveGivesWay(r.code)) {
      pinnedTransient = { source: candidate, code: r.code };
      break;
    }
  }
  if (!resolved?.playlistUrl) {
    // A transient failure on the source that owns the bytes must surface
    // as a RETRYABLE error (no hard-error pattern matches this copy), so
    // scheduleAutoResume re-runs against the same source instead of
    // flipping to another cut and wiping everything downloaded so far.
    if (pinnedTransient) {
      throw new Error(
        `${pinnedTransient.source} is temporarily failing for this title${
          pinnedTransient.code ? ` (${pinnedTransient.code})` : ""
        } — the download will retry in a few seconds.`
      );
    }
    // Headline the most systemic failure — connectivity/config beats "this
    // title isn't on that source" — and list every candidate in the trail.
    const rank = (c?: string) =>
      c === "upstream_unreachable" || c === "blocked"
        ? 0
        : c === "resolution_failed"
          ? 1
          : c === "resolver_unconfigured"
            ? 2
            : c === "not_found" || c === "no_streams"
              ? 4
              : 3;
    const worst = [...failures].sort((a, b) => rank(a.code) - rank(b.code))[0];
    throw new Error(
      diagnoseResolveFailure({
        code: worst?.code,
        detail: worst?.detail,
        attempts: failures.map((f) => ({
          source: f.source,
          ok: false,
          error: f.error,
        })),
      })
    );
  }
  rec.usedSource = resolved.usedSource ?? source;
  await upsertRecord(rec);

  // 1b. IntroDB segments (TV only, needs the resolved IMDb id): captured now
  // so skip intro/recap + outro Up Next keep working fully offline.
  if (
    req.type === "tv" &&
    req.season != null &&
    req.episode != null &&
    resolved.imdbId
  ) {
    try {
      rec.segments = await fetchSegments({
        imdbId: resolved.imdbId,
        season: req.season,
        episode: req.episode,
      });
    } catch {
      /* segments are a bonus — never fail the download for them */
    }
  }

  // 2–3b across mirrors: vidsrc-sh hands back several signed mirrors
  // (alternate hosts for the same title). A dead first mirror (403 farm)
  // must not fail the title — walk them in order. Single-candidate sources
  // behave exactly as before (one iteration).
  let mirrorCandidates: string[] =
    resolved.usedSource === "vidsrc-sh" &&
    Array.isArray(resolved.playlistUrls) &&
    resolved.playlistUrls.length > 1
      ? [...resolved.playlistUrls]
      : [resolved.playlistUrl];
  // Resume: the mirror whose parse produced the bytes on disk goes first.
  // Signed URLs re-sign (and rotate order) on every resolve, so match by
  // mirror identity, never the exact URL. A miss simply keeps resolver
  // order — the rendition guard below only wipes if the cut really differs.
  if (hasProgress && rec.usedPlaylistUrl) {
    const want = mirrorIdentity(rec.usedPlaylistUrl);
    const pinnedMirror = mirrorCandidates.filter(
      (u) => mirrorIdentity(u) === want
    );
    if (pinnedMirror.length > 0) {
      const rest = mirrorCandidates.filter((u) => mirrorIdentity(u) !== want);
      mirrorCandidates = [...pinnedMirror, ...rest];
    }
  }
  type MirrorParse = {
    mediaUrl: string;
    mediaText: string;
    bandwidth: number;
    pickedVariant: VariantInfo | null;
    isMaster: boolean;
    parts: MediaParts;
    audioParts: MediaParts | null;
    audioUrl: string | null;
    audioText: string | null;
    audioEntry: AudioEntry | null;
    subParts: MediaParts | null;
    subUrl: string | null;
    subText: string | null;
    subEntry: SubEntry | null;
  };
  const tryMirror = async (candidate: string): Promise<MirrorParse> => {
    // 2. Master → variant at/below the quality setting. The resolver may
    // hand back a relative same-origin proxy path — absolutize once so every
    // URL resolution below (variants, segments, keys) actually works.
    const playlistBase = new URL(
      candidate,
      window.location.origin
    ).toString();
    const masterRes = await fetchPieceRetry(playlistBase, signal, null, null);
    if (!masterRes.ok) throw new Error(`Stream lookup failed (${masterRes.status})`);
    const masterText = await masterRes.text();
    throwIfAborted();

    let mediaUrl = playlistBase;
    let mediaText = masterText;
    let bandwidth = 0;
    let pickedVariant: VariantInfo | null = null;
    const isMaster = isMasterPlaylist(masterText);
    if (isMaster) {
      const variants = parseMasterVariants(masterText, playlistBase);
      pickedVariant = pickVariant(variants, rec.quality);
      if (!pickedVariant) {
        // Quality gap (e.g. 480p requested, lowest rendition is 720p): say so
        // plainly so the user can switch quality instead of guessing.
        const lowest = minVariantHeight(variants);
        throw new Error(
          rec.quality === "best" || lowest == null
            ? "No playable quality found for this title."
            : `Not available in ${rec.quality}p (lowest is ${lowest}p) — switch quality in Download settings and retry.`
        );
      }
      const vRes = await fetchPieceRetry(pickedVariant.url, signal, null, null);
      if (!vRes.ok) throw new Error(`Quality fetch failed (${vRes.status})`);
      mediaText = await vRes.text();
      mediaUrl = pickedVariant.url;
      bandwidth = pickedVariant.bandwidth;
      throwIfAborted();
    }

    // 3. Segments + keys. Sample-AES can't be cached — refuse up front.
    const parts = parseMediaPlaylist(mediaText, mediaUrl);
    if (parts.sampleAes) {
      throw new Error("This source is encrypted and can't be saved offline.");
    }
    if (parts.segments.length === 0) {
      throw new Error("No video segments found in this stream.");
    }

    // 3b. Separate audio rendition. Vix-style masters pair each video variant
    // with an EXT-X-MEDIA audio group — skip this and downloads play silent.
    let audioParts: MediaParts | null = null;
    let audioUrl: string | null = null;
    let audioText: string | null = null;
    let audioEntry: AudioEntry | null = null;
    if (isMaster && pickedVariant?.audioGroup) {
      const entries = parseMasterAudio(masterText, playlistBase).filter(
        (e) => e.groupId === (pickedVariant as VariantInfo).audioGroup
      );
      audioEntry = pickAudioEntry(
        entries,
        loadVixSettings().audio || "en",
        matchLang
      );
      if (audioEntry) {
        const aRes = await fetchPieceRetry(audioEntry.url, signal, null, null);
        if (!aRes.ok) throw new Error(`Audio track fetch failed (${aRes.status})`);
        let aText = await aRes.text();
        audioUrl = audioEntry.url;
        if (isMasterPlaylist(aText)) {
          const aVars = parseMasterVariants(aText, audioEntry.url);
          if (aVars.length === 0) {
            throw new Error("No audio track found for this title.");
          }
          const aPicked = aVars[0]!;
          const avRes = await fetchPieceRetry(aPicked.url, signal, null, null);
          if (!avRes.ok) throw new Error(`Audio track fetch failed (${avRes.status})`);
          aText = await avRes.text();
          audioUrl = aPicked.url;
        }
        const parsed = parseMediaPlaylist(aText, audioUrl);
        if (parsed.sampleAes) {
          throw new Error("This source is encrypted and can't be saved offline.");
        }
        if (parsed.segments.length === 0) {
          // Audio declared but empty — video-only rather than a failure.
          audioEntry = null;
          audioUrl = null;
        } else {
          audioParts = parsed;
          audioText = aText;
        }
        throwIfAborted();
      }
    }

    // 3c. Stream captions. Grab the picked variant's SUBTITLES rendition so
    // the download keeps the stream's own frame-accurate CC offline — far
    // better timing than an external OpenSubtitles guess. Bonus like the
    // text cascade: any failure here continues without captions.
    let subParts: MediaParts | null = null;
    let subUrl: string | null = null;
    let subText: string | null = null;
    let subEntry: SubEntry | null = null;
    if (isMaster && pickedVariant?.subGroup) {
      const subGroup = pickedVariant.subGroup;
      try {
        const subs = parseMasterSubtitles(masterText, playlistBase).filter(
          (e) => e.groupId === subGroup
        );
        // pickAudioEntry is typed on AudioEntry; re-find the chosen element
        // in `subs` so its rawUri (master rewrites need it) survives.
        const best = pickAudioEntry(subs, loadVixSettings().subs, matchLang);
        const wanted = best ? (subs.find((e) => e.url === best.url) ?? null) : null;
        if (wanted) {
          const sRes = await fetchPieceRetry(wanted.url, signal, null, null);
          if (sRes.ok) {
            let sText = await sRes.text();
            let sUrl = wanted.url;
            if (isMasterPlaylist(sText)) {
              const sVars = parseMasterVariants(sText, sUrl);
              const sv = sVars[0];
              if (sv) {
                const svRes = await fetchPieceRetry(sv.url, signal, null, null);
                if (svRes.ok) {
                  sText = await svRes.text();
                  sUrl = sv.url;
                }
              }
            }
            const parsed = parseMediaPlaylist(sText, sUrl);
            if (parsed.segments.length > 0 && !parsed.sampleAes) {
              subParts = parsed;
              subText = sText;
              subUrl = sUrl;
              subEntry = wanted;
            }
          }
        }
      } catch (e) {
        if (signal.aborted) throw e;
        /* captions are a bonus — the download continues without them */
      }
    }
    return {
      mediaUrl,
      mediaText,
      bandwidth,
      pickedVariant,
      isMaster,
      parts,
      audioParts,
      audioUrl,
      audioText,
      audioEntry,
      subParts,
      subUrl,
      subText,
      subEntry,
    };
  };
  // Always re-armed per attempt (seed and bandwidth differ per mirror) —
  // every estimate converges on measured bytes in reportProgress.
  let refineEstimate = false;

  // 5. Fetch everything into the cache (resume skips what's already there).
  const cache = await caches.open(DL_CACHE);
  // Seeded from the record: same-quality resumes keep owned files so nothing
  // verified earlier is ever orphaned.
  const fileUrls = new Set<string>(rec.fileUrls);
  /** Files this attempt referenced (cache hit or newly stored), plus playlists. */
  let touched = new Set<string>();
  const seedFiles = new Set<string>(rec.fileUrls);
  // Subtitles overlap the segment downloads (same 30s total budget as a
  // sequential fetch, but off the critical path): a hung subs fetch resolves
  // to null instead of parking a finished video at 99%.
  const subsSignal = linkSignals([signal, AbortSignal.timeout(30000)]);
  const subsPromise = (async () => {
    const sub = await fetchDownloadSubs(req, resolved.imdbId, subsSignal);
    const alts: { vtt: string; label: string }[] = [];
    // OpenSubs spares only when the picker opted into a file provider…
    const subOpts = loadVixSettings().subSource;
    if (subOpts === "vdrk" || subOpts === "auto" || subOpts === "opensub") {
      const fetched = await fetchDownloadSubAlts(
        req,
        resolved.imdbId,
        sub?.fileId,
        subsSignal
      );
      alts.push(...fetched);
    }
    // …but the top-2 SubDL results are stored for EVERY download, so the
    // offline copy always carries them as swap spares regardless of picker.
    try {
      if (!subsSignal.aborted) {
        const dlAlts = await fetchDownloadSubDlAlts(
          req,
          resolved.imdbId,
          sub?.fileId,
          subsSignal
        );
        alts.push(...dlAlts);
      }
    } catch {
      /* SubDL spares are a bonus — never fail the download for them */
    }
    const entries = [
      ...(sub ? [{ vtt: sub.vtt, label: sub.label }] : []),
      ...alts,
    ].slice(0, 5);
    return {
      subVtt: sub?.vtt ?? null,
      subLabel: sub?.label ?? null,
      subAlts: entries,
    };
  })();
  // Observed on every path (avoids unhandled rejections when an abort below
  // skips the later await); the awaited copy still surfaces user aborts.
  void subsPromise.catch(() => {});
  let doneSeg = 0;
  /** Positions that FAILED into gaps this attempt — counted in doneSeg but carrying no bytes. */
  let gapSegs = 0;
  let measuredBytes = 0;

  // withEndlist: every stored media playlist terminates, so offline playback
  // is always VOD (finite duration → working scrub bar, no live-window stop).
  const mpegResponse = (text: string, noStore = false) =>
    new Response(withEndlist(text), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": noStore ? "no-store" : "public, max-age=31536000",
      },
    });

  // Watchdog clock: refreshed on every completed piece (hits count too).
  // If the loop stops completing with work remaining, the download failed
  // silently before — now it surfaces as error + retry instead.
  let lastProgressAt = Date.now();

  const reportProgress = async () => {
    lastProgressAt = Date.now();
    // Display never moves backward (resume seed) and verification still
    // counts every piece, so the final totals stay exact either way.
    rec.bytesDone = Math.max(rec.bytesDone, measuredBytes);
    rec.doneSegments = Math.max(rec.doneSegments, doneSeg);
    // Every seed (advertised bandwidth, quality guess, byte pre-scan)
    // converges on measured reality: total ≈ measured / fraction-complete,
    // adopted once past warmup and only when it disagrees by >10% (avoids
    // jitter on uniform segments). Gaps count as progress but carry no
    // bytes — folding them into the fraction used to drag the estimate
    // DOWN on dead-segment runs, so the extrapolation excludes them.
    let estimatePatch: number | null = null;
    const measuredSegs = doneSeg - gapSegs;
    if (refineEstimate && measuredSegs >= 6 && rec.totalSegments > 0) {
      const frac = measuredSegs / rec.totalSegments;
      if (frac >= 0.03 && frac < 1) {
        const refined = Math.round(measuredBytes / frac);
        const est = rec.estimateBytes;
        if (refined > 0 && (est <= 0 || Math.abs(refined - est) / est > 0.1)) {
          rec.estimateBytes = refined;
          estimatePatch = refined;
        }
      }
    }
    // Track owned files continuously so a mid-flight pause/cancel/delete
    // removes partial bytes instead of orphaning them.
    rec.fileUrls = [...fileUrls];
    await updateProgress(rec.key, {
      bytesDone: rec.bytesDone,
      doneSegments: rec.doneSegments,
      fileUrls: rec.fileUrls,
      ...(estimatePatch != null ? { estimateBytes: estimatePatch } : {}),
    });
  };

  type PieceJob = {
    original: string;
    dlUrl: string;
    /** Previous URL-keyed copy, copied across once so it is not downloaded again. */
    legacyUrl: string | null;
    kind: "seg" | "key" | "init";
    segNo: number;
    /** 0-based position among segments. Stable across signed-URL refreshes. */
    index: number;
    range: ByteRange | null;
    encrypted: boolean;
    refreshed: boolean;
    /** Subtitle (text) piece — HTML-sniff rejection must not reject VTT. */
    textOk?: boolean;
  };

  const rememberFile = (url: string) => {
    fileUrls.add(url);
    touched.add(url);
  };

  const storedSize = async (res: Response): Promise<number> => {
    const n = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(n) && n > 0) return n;
    try {
      const blob = await res.clone().blob();
      if (blob.size > 0) return blob.size;
    } catch {
      /* a cache entry with no readable size is still a body we already paid for */
    }
    return 1;
  };

  /**
   * Fetch every init, key, and segment. Pieces are stored by index, so a
   * refreshed playlist does not miss them. A 403 retries that index only.
   * Network stalls throw and keep every byte already stored.
   */
  const storeParts = async (
    list: MediaParts,
    label: string,
    role: "v" | "a" | "s",
    reload: () => Promise<MediaParts | null>,
    opts?: { lenient?: boolean }
  ): Promise<number[]> => {
    const gaps = new Set<number>();
    // Lenient (subtitles): a wrecked caption rendition must never sink the
    // title — every failure lands as a gap and the caller decides later.
    const budget = opts?.lenient
      ? Number.MAX_SAFE_INTEGER
      : gapBudget(list.segments.length);
    const jobs: PieceJob[] = [];
    let metaN = 0;
    for (const map of list.maps) {
      const index = metaN++;
      jobs.push({
        original: map.url,
        dlUrl: segmentIndexUrl(
          rec.key,
          role === "v" ? "vi" : role === "a" ? "ai" : "si",
          index
        ),
        legacyUrl: offlinePieceUrl(map.url, map.byteRange),
        kind: "init",
        segNo: 0,
        index,
        range: map.byteRange,
        encrypted: false,
        refreshed: false,
      });
    }
    metaN = 0;
    for (const k of list.keys) {
      if (k.method === "NONE") continue;
      const index = metaN++;
      jobs.push({
        original: k.url,
        dlUrl: segmentIndexUrl(
          rec.key,
          role === "v" ? "vk" : role === "a" ? "ak" : "sk",
          index
        ),
        legacyUrl: offlinePieceUrl(k.url, null),
        kind: "key",
        segNo: 0,
        index,
        range: null,
        encrypted: false,
        refreshed: false,
      });
    }
    let segTotalCount = 0;
    for (const s of list.segments) {
      const index = segTotalCount;
      segTotalCount++;
      jobs.push({
        original: s.url,
        dlUrl: segmentIndexUrl(rec.key, role, index),
        legacyUrl: offlinePieceUrl(s.url, s.byteRange),
        kind: "seg",
        segNo: segTotalCount,
        index,
        range: s.byteRange,
        encrypted: s.encrypted,
        refreshed: false,
        textOk: role === "s",
      });
    }
    let reloadPromise: Promise<MediaParts | null> | null = null;
    const reloadOnce = (): Promise<MediaParts | null> => {
      if (!reloadPromise) {
        reloadPromise = reload().catch((err: unknown) => {
          if (signal.aborted) throw err;
          return null;
        });
      }
      return reloadPromise;
    };

    const pool = new AbortController();
    const stopPool = () => {
      if (!pool.signal.aborted) pool.abort();
    };
    const gapOrThrow = async (index: number, err: PieceDownloadError) => {
      if (gaps.size >= budget) {
        stopPool();
        throw err;
      }
      gaps.add(index);
      doneSeg++;
      gapSegs++;
      await reportProgress();
    };

    const fetchJob = async (job: PieceJob): Promise<Response> => {
      try {
        return await fetchPieceRetry(job.original, signal, pool.signal, job.range, 5);
      } catch (err) {
        if (err instanceof PoolStopped || signal.aborted) throw err;
        if (!(err instanceof PieceDownloadError) || err.reason !== "auth" || job.kind !== "seg") {
          throw err;
        }
        // One 403 refreshes this index's URL. It does not restart the title.
        if (indexRetryAction(job.refreshed) === "gap") throw err;
        const next = await reloadOnce();
        job.refreshed = true;
        if (next && next.segments.length === segTotalCount) {
          const repl = next.segments[job.index];
          if (repl) {
            job.original = repl.url;
            job.range = repl.byteRange;
            job.encrypted = repl.encrypted;
            return await fetchPieceRetry(job.original, signal, pool.signal, job.range, 3);
          }
        }
        throw err;
      }
    };

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        throwIfAborted();
        if (pool.signal.aborted) return;
        const live = getRecordSync(rec.key);
        if (!live || live.state === "paused") throw abortError();
        if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
          stopPool();
          throw new PieceDownloadError("Stalled — tap to retry", "network");
        }
        const i = cursor++;
        if (i >= jobs.length) return;
        const job = jobs[i]!;
        const segNo = job.segNo;
        const fail = (msg: string, reason: PieceFailureReason) =>
          new PieceDownloadError(
            job.kind === "seg" && segNo > 0
              ? `${label} segment ${segNo}/${segTotalCount} ${msg}`
              : `${label} ${job.kind} ${msg}`,
            reason
          );

        let hit = await cache.match(job.dlUrl);
        if (!hit && job.legacyUrl && job.legacyUrl !== job.dlUrl) {
          const old = await cache.match(job.legacyUrl);
          if (old) {
            const size = await storedSize(old);
            if (size > 0) {
              await enqueueCache(() => cache.put(job.dlUrl, old.clone()));
              hit = await cache.match(job.dlUrl);
            }
          }
        }
        if (hit) {
          // Already paid for. Do not sniff and do not download again —
          // EXCEPT a byterange piece whose stored size doesn't match the
          // window: that's a truncated/offset-wrong entry that would be
          // re-served (and re-trusted) forever. Evict and refetch it.
          const size = await storedSize(hit);
          if (job.range && size !== job.range.length) {
            await enqueueCache(() => cache.delete(job.dlUrl));
            hit = undefined;
          } else {
            rememberFile(job.dlUrl);
            if (job.kind === "seg") {
              doneSeg++;
              measuredBytes += size;
              await reportProgress();
            }
            continue;
          }
        }

        let res: Response;
        try {
          res = await fetchJob(job);
        } catch (err) {
          if (err instanceof PoolStopped) return;
          if (!(err instanceof PieceDownloadError)) throw err;
          if (err.reason === "network") {
            stopPool();
            throw err;
          }
          const dead = fail(err.message, "dead");
          if (job.kind === "seg") {
            await gapOrThrow(job.index, dead);
            continue;
          }
          stopPool();
          throw dead;
        }

        let buf = await res.arrayBuffer();
        buf = sliceToRange(buf, res.status, job.range);
        if (buf.byteLength === 0) {
          try {
            const res2 = await fetchJob(job);
            buf = sliceToRange(await res2.arrayBuffer(), res2.status, job.range);
            res = res2;
          } catch (err) {
            if (err instanceof PoolStopped) return;
            if (err instanceof PieceDownloadError && err.reason === "network") {
              stopPool();
              throw err;
            }
            if (err instanceof PieceDownloadError && job.kind === "seg") {
              await gapOrThrow(job.index, fail(err.message, "dead"));
              continue;
            }
            if (err instanceof PieceDownloadError) {
              stopPool();
              throw err;
            }
            buf = new ArrayBuffer(0);
          }
        }
        const bytes = new Uint8Array(buf);
        // VTT caption segments ARE text — only emptiness disqualifies them
        // (the HTML-error-page sniff belongs to audio/video pieces).
        const rejected = job.textOk
          ? bytes.byteLength === 0
          : segmentShouldReject(
              bytes.subarray(0, Math.min(bytes.byteLength, 256)),
              job.kind
            );
        if (rejected) {
          const dead = fail(bytes.byteLength === 0 ? "was empty." : "was not media.", "dead");
          if (job.kind === "seg") {
            await gapOrThrow(job.index, dead);
            continue;
          }
          stopPool();
          throw dead;
        }
        const stored = new Response(buf, {
          headers: {
            "Content-Type":
              res.headers.get("content-type") ?? "application/octet-stream",
            "Content-Length": String(buf.byteLength),
            "Cache-Control": "public, max-age=31536000",
          },
        });
        try {
          await enqueueCache(() => cache.put(job.dlUrl, stored));
        } catch (e) {
          if (
            e instanceof DOMException &&
            (e.name === "QuotaExceededError" || e.code === 22)
          ) {
            stopPool();
            throw new PieceDownloadError(
              "Out of device space — free storage and retry.",
              "quota"
            );
          }
          throw e;
        }
        rememberFile(job.dlUrl);
        if (job.kind === "seg") {
          doneSeg++;
          measuredBytes += buf.byteLength;
          await reportProgress();
          await checkpointRecord();
        }
        throwIfAborted();
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(pieceConcurrency(), jobs.length) }, () => worker())
      );
    } catch (err) {
      stopPool();
      throw err;
    }
    return [...gaps];
  };

  /**
   * One full download attempt against a single parsed mirror: estimate →
   * quota → segments → playlists → subs → done. Throws PieceDownloadError
   * for persistent piece failures (caller switches mirrors); anything else
   * (abort, quota, device space) propagates.
   */
  const reloadMedia = async (url: string): Promise<MediaParts | null> => {
    try {
      const res = await fetchPieceRetry(url, signal, null, null, 2);
      const text = await res.text();
      const parts = parseMediaPlaylist(text, url);
      return parts.segments.length ? parts : null;
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
  };

  /**
   * The mirror candidate whose parse the current attempt is running
   * against. Recorded with the rendition so a later resume can pin the
   * mirror that produced the bytes on disk.
   */
  let activeMirrorUrl: string | null = null;

  const downloadAttempt = async (m: MirrorParse): Promise<void> => {
    // Local recount only. Persisted progress never takes the lower number.
    doneSeg = 0;
    gapSegs = 0;
    measuredBytes = 0;
    touched = new Set();
    lastProgressAt = Date.now();
    const rendition = encodeRendition(
      `${m.pickedVariant?.height ?? 0}:${m.parts.segments.length}`,
      `${m.audioParts?.segments.length ?? 0}`,
      `${m.subParts?.segments.length ?? 0}`
    );
    const sourceChanged = prevSource !== "" && prevSource !== rec.usedSource;
    const plan = planRenditionWipe({
      stored: rec.rendition,
      next: rendition,
      sourceChanged,
    });
    // A parse shorter than what we already stored (same source) is a
    // truncated playlist — reverify below only compares two fetches of the
    // SAME url, so a consistently short answer would pass it and wipe the
    // row. Keep every stored byte and retry instead (escape hatch for a
    // genuine re-cut: delete + redownload, which starts with nothing stored).
    if (
      isShrunkParse({
        storedDurationSec: rec.durationSec,
        nextDurationSec: m.parts.durationSec,
        sourceChanged,
      })
    ) {
      console.warn("[downloads] parse shrink — keeping stored bytes", {
        key: rec.key,
        storedDurationSec: rec.durationSec,
        nextDurationSec: m.parts.durationSec,
        source: rec.usedSource,
        previousSource: prevSource,
        mirror: activeMirrorUrl ?? m.mediaUrl,
      });
      throw new PieceDownloadError(
        "Playlist shrank since the last attempt — kept stored bytes; will retry.",
        "dead"
      );
    }
    // Verify BEFORE destroying. A dying mirror hands back a truncated parse
    // (900 of 1000 segments); wiping against it and then switching mirrors
    // used to destroy the title twice over. Re-fetch only the playlists whose
    // group would be wiped — if the second parse disagrees with the first,
    // the mirror is untrustworthy: keep every stored byte and move on.
    if (plan.groups.length > 0) {
      const reverify = async (url: string): Promise<number | null> => {
        try {
          const res = await fetchPieceRetry(url, signal, null, null, 2);
          const parts = parseMediaPlaylist(await res.text(), url);
          return parts.segments.length;
        } catch (err) {
          // An expired signed URL must propagate so the mirror loop refreshes
          // and retries instead of misreading a 403 as instability; a dead
          // network stops the run rather than burning through mirrors.
          if (
            signal.aborted ||
            err instanceof AuthRefresh ||
            (err instanceof PieceDownloadError && err.reason === "network")
          ) {
            throw err;
          }
          return null;
        }
      };
      let unstable = false;
      if (plan.groups.includes("video")) {
        const n = await reverify(m.mediaUrl);
        if (n == null || n !== m.parts.segments.length) unstable = true;
      }
      if (!unstable && plan.groups.includes("audio") && m.audioUrl && m.audioParts) {
        const n = await reverify(m.audioUrl);
        if (n == null || n !== m.audioParts.segments.length) unstable = true;
      }
      if (!unstable && plan.groups.includes("subs") && m.subUrl && m.subParts) {
        const n = await reverify(m.subUrl);
        if (n == null || n !== m.subParts.segments.length) unstable = true;
      }
      if (unstable) {
        throw new PieceDownloadError(
          "Playlist changed during verification — kept stored bytes; will retry.",
          "dead"
        );
      }
    }
    rec.durationSec = m.parts.durationSec;
    rec.totalSegments =
      m.parts.segments.length +
      (m.audioParts?.segments.length ?? 0) +
      (m.subParts?.segments.length ?? 0);
    // Estimate policy: seed ONLY when we have none. Re-seeding every attempt
    // from the advertised bandwidth (a peak that varies per mirror — 430MB ↔
    // 580MB on the same episode) made the displayed total flap and re-trip
    // quota. Measured bytes are the sole ongoing authority (refineEstimate
    // below, armed every attempt). A wipe just changed the file's shape —
    // drop the old number so this attempt seeds fresh from the real parse.
    if (plan.groups.length > 0) rec.estimateBytes = 0;
    const needSeed = !(rec.estimateBytes > 0);
    if (needSeed) {
      // Advertised bandwidth is a peak, not bytes on the wire: a master
      // claiming 2.89 Mbps × 3480s projected 1258 MB while its segments
      // sample to ~293 MB — hence the byte pre-scan below and the
      // measured-bytes refinement that keeps correcting in flight.
      rec.estimateBytes =
        estimateBytes(m.bandwidth, m.parts.durationSec) ||
        (m.parts.durationSec > 0
          ? Math.round((fallbackBitrateBps(rec.quality) * m.parts.durationSec) / 8)
          : 0);
    }
    refineEstimate = true;
    if (needSeed) {
      // Bounded: a hung probe must never stall the start — after 10s the
      // bandwidth/guess seed stands and reportProgress refines it anyway.
      const scan = (async () => {
        const [v, a] = await Promise.all([
          scanPartBytes(m.parts, signal),
          m.audioParts ? scanPartBytes(m.audioParts, signal) : Promise.resolve(0),
        ]);
        return v + a;
      })();
      const scanned = await Promise.race([
        scan,
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 10_000)),
      ]);
      if (scanned > 0) rec.estimateBytes = scanned;
    }
    await upsertRecord(rec);

    // 4. Quota BEFORE the wipe: a refusal ("needs ~X — free space") must not
    // have already destroyed bytes for an attempt that can't run anyway.
    await enforceQuota(rec, signal);

    if (plan.groups.length > 0) {
      // This destroys stored bytes — say so, loudly. A silent wipe here is
      // what made the "downloads keep restarting" report impossible to
      // diagnose (the old code logged nothing).
      console.warn("[downloads] rendition change — wiping progress", {
        key: rec.key,
        from: rec.rendition,
        to: rendition,
        groups: plan.groups,
        source: rec.usedSource,
        previousSource: prevSource,
        mirror: activeMirrorUrl ?? m.mediaUrl,
      });
      // Persist the reset BEFORE deleting: a crash between the two used to
      // leave the stored row claiming files that were already gone (a
      // "done"/progress row pointing at nothing). Reset first, delete after.
      if (plan.groups.length === 3) {
        const staleUrls = rec.fileUrls;
        fileUrls.clear();
        touched.clear();
        rec.bytesDone = 0;
        rec.doneSegments = 0;
        rec.fileUrls = [];
        await upsertRecord(rec);
        await deleteRecordFiles({ ...rec, fileUrls: staleUrls });
      } else {
        // Partial wipe: drop only the groups whose cut changed. An
        // audio-track flap keeps paid-for video (and vice versa); the kept
        // positions re-verify as cache hits on this attempt's walk.
        const doomed = rec.fileUrls.filter((u) => {
          const info = pieceInfo(u);
          return info != null && plan.groups.includes(info.group);
        });
        if (doomed.length > 0) {
          let bytesDrop = 0;
          let segsDrop = 0;
          for (const u of doomed) {
            const info = pieceInfo(u);
            if (!info?.isSegment) continue;
            segsDrop += 1;
            const hit = await cache.match(u);
            if (hit) bytesDrop += await storedSize(hit);
          }
          const doomedSet = new Set(doomed);
          rec.fileUrls = rec.fileUrls.filter((u) => !doomedSet.has(u));
          for (const u of doomed) fileUrls.delete(u);
          rec.bytesDone = Math.max(0, rec.bytesDone - bytesDrop);
          rec.doneSegments = Math.max(0, rec.doneSegments - segsDrop);
          await upsertRecord(rec);
          await Promise.all(doomed.map((u) => cache.delete(u).catch(() => false)));
        }
      }
    }
    rec.rendition = rendition;
    if (activeMirrorUrl) rec.usedPlaylistUrl = activeMirrorUrl;
    // Wipes persisted their counter reset above; this persists the new
    // signature so the next attempt compares against what's actually stored.
    if (plan.groups.length > 0) await upsertRecord(rec);

    const videoGaps = await storeParts(m.parts, "Video", "v", () => reloadMedia(m.mediaUrl));
    throwIfAborted();
    const audioSource = m.audioUrl;
    const audioGaps =
      m.audioParts && audioSource
        ? await storeParts(m.audioParts, "Audio", "a", () => reloadMedia(audioSource))
        : [];
    throwIfAborted();

    // 5b. Stream captions (lenient — see storeParts): every failure is a
    // gap, and a rendition that lost more than a third of its cues is
    // dropped below instead of sinking the title.
    const subGaps =
      m.subParts && m.subUrl
        ? await storeParts(
            m.subParts,
            "Subtitles",
            "s",
            () => reloadMedia(m.subUrl!),
            { lenient: true }
          )
        : [];
    throwIfAborted();

    // 6. Store rewritten playlists last — only complete sets ever play.
    // Segment URLs are index keys, so a later signature refresh still hits.
    const videoStoredUrl = segmentIndexUrl(rec.key, "vp", 0);
    const videoPieceUrls = m.parts.segments.map((_, i) => segmentIndexUrl(rec.key, "v", i));
    await enqueueCache(() =>
      cache.put(
        videoStoredUrl,
        mpegResponse(
          rewritePlaylistToIndexUrls(m.mediaText, videoPieceUrls, {
            mapUrls: m.parts.maps.map((_, i) => segmentIndexUrl(rec.key, "vi", i)),
            keyUrls: m.parts.keys
              .filter((k) => k.method !== "NONE")
              .map((_, i) => segmentIndexUrl(rec.key, "vk", i)),
            gapIndexes: new Set(videoGaps),
          })
        )
      )
    );
    rememberFile(videoStoredUrl);

    // 6b. Captured stream CC: store the rewritten caption playlist, or drop
    // the capture when too many cue segments went missing (a broken caption
    // track must never ship — external VTT stays the fallback).
    let storedSubUrl: string | null = null;
    const subShipOk =
      m.subParts && subGaps.length <= Math.max(8, Math.ceil(m.subParts.segments.length / 3));
    if (subShipOk && m.subParts && m.subText && m.subEntry) {
      const subStoredUrl = segmentIndexUrl(rec.key, "sp", 0);
      const subPieceUrls = m.subParts.segments.map((_, i) =>
        segmentIndexUrl(rec.key, "s", i)
      );
      await enqueueCache(() =>
        cache.put(
          subStoredUrl,
          mpegResponse(
            rewritePlaylistToIndexUrls(m.subText!, subPieceUrls, {
              mapUrls: [],
              keyUrls: [],
              gapIndexes: new Set(subGaps),
            })
          )
        )
      );
      rememberFile(subStoredUrl);
      storedSubUrl = subStoredUrl;
    }

    let topText: string;
    const audioUrl = m.audioUrl;
    const audioText = m.audioText;
    if (m.audioParts && audioUrl && audioText && m.audioEntry && m.pickedVariant) {
      const audioStoredUrl = segmentIndexUrl(rec.key, "ap", 0);
      const audioPieceUrls = m.audioParts.segments.map((_, i) => segmentIndexUrl(rec.key, "a", i));
      await enqueueCache(() =>
        cache.put(
          audioStoredUrl,
          mpegResponse(
            rewritePlaylistToIndexUrls(audioText, audioPieceUrls, {
              mapUrls: m.audioParts!.maps.map((_, i) => segmentIndexUrl(rec.key, "ai", i)),
              keyUrls: m.audioParts!.keys
                .filter((k) => k.method !== "NONE")
                .map((_, i) => segmentIndexUrl(rec.key, "ak", i)),
              gapIndexes: new Set(audioGaps),
            })
          )
        )
      );
      rememberFile(audioStoredUrl);
      topText = buildOfflineMaster({
        variant: m.pickedVariant,
        videoPlaylistUrl: videoStoredUrl,
        audio: m.audioEntry,
        audioPlaylistUrl: audioStoredUrl,
      });
    } else {
      topText = rewritePlaylistToIndexUrls(m.mediaText, videoPieceUrls, {
        mapUrls: m.parts.maps.map((_, i) => segmentIndexUrl(rec.key, "vi", i)),
        keyUrls: m.parts.keys
          .filter((k) => k.method !== "NONE")
          .map((_, i) => segmentIndexUrl(rec.key, "vk", i)),
        gapIndexes: new Set(videoGaps),
      });
      // Stream CC can only hang off a master playlist, but this top level is
      // the variant itself (muxed audio — no separate rendition fetch). The
      // captured rendition below would end up as a dead #EXT-X-MEDIA line,
      // so wrap the stored variant in a synthetic master to make it reachable.
      if (m.isMaster && m.pickedVariant && storedSubUrl && m.subEntry) {
        topText = buildOfflineMaster({
          variant: m.pickedVariant,
          videoPlaylistUrl: videoStoredUrl,
          audio: null,
          audioPlaylistUrl: null,
        });
      }
    }
    // Replace every remote subtitle group with the captured rendition (or
    // none): remote URIs are unreachable offline and would error the moment
    // the user enables captions.
    topText = withOfflineSubtitles(
      topText,
      storedSubUrl && m.subEntry
        ? {
            name: m.subEntry.name,
            language: m.subEntry.language,
            uri: storedSubUrl,
          }
        : null
    );
    const playlistKey = dlPlaylistUrl(rec.key);
    await enqueueCache(() => cache.put(playlistKey, mpegResponse(topText, true)));
    rememberFile(playlistKey);
    // Drop pieces from an abandoned mirror now that this one is complete.
    for (const u of [...fileUrls]) {
      if (touched.has(u)) continue;
      await enqueueCache(() => cache.delete(u).catch(() => false));
      fileUrls.delete(u);
    }
    rec.fileUrls = [...fileUrls];

    // 7. Auto-subtitles: same cascade the player uses (VDRK → OpenSubs),
    // plus spares (best-first, up to 3 total) for offline switching when the
    // default misaligns. Skipped entirely when subs are off/stream-only.
    // Overlapped with the segment downloads above: this await only collects an
    // already-running fetch, so completion never parks at 99% on slow subs.
    try {
      const subs = await subsPromise;
      if (subs.subVtt) {
        rec.subVtt = subs.subVtt;
        rec.subLabel = subs.subLabel;
      }
      if (subs.subAlts.length > 0) rec.subAlts = subs.subAlts;
    } catch (e) {
      // User pause/cancel (parent signal) still stops the download; a subs
      // timeout just completes the video without subtitles.
      if (signal.aborted) throw e;
      /* subs are a bonus — never fail the download for them */
    }

    rec.sizeBytes = Math.max(rec.bytesDone, measuredBytes);
    rec.bytesDone = rec.sizeBytes;
    rec.state = "done";
    rec.error = undefined;
    rec.retryable = false;
    // A finished run restores the auto-quality budget: without this the
    // lifetime counter kept counting against future, unrelated failures and
    // the row could never auto-recover again (manual retry was the only reset).
    rec.autoAttempts = 0;
    rec.downloadedAt = Date.now();
    rec.lastUsedAt = Date.now();
    // Honest partial state: the holes this run skipped stay on the record
    // so the UI can badge "Partial" and repairDownload fetches exactly
    // these indexes instead of re-walking the whole title.
    const gaps = [
      ...videoGaps.map((index) => ({ role: "v" as const, index })),
      ...audioGaps.map((index) => ({ role: "a" as const, index })),
      // Only cues we actually shipped owe a repair — a dropped rendition
      // has no playlist to point at.
      ...(storedSubUrl ? subGaps.map((index) => ({ role: "s" as const, index })) : []),
    ];
    rec.missing = gaps.length > 0 ? gaps : undefined;
    await commitRecord(rec);
    // Completion is silent at the engine layer by design — broadcast for UI
    // (toast with View action lives in the app shell, not here).
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("tvtime:download-done", {
          detail: { key: rec.key, title: rec.title },
        })
      );
    }
  };

  // Walk mirrors. A network stall keeps every finished segment and stops
  // (the caller continues later). An expired link refreshes this mirror once.
  // A dead mirror is remembered; its bytes stay until another mirror finishes
  // or, if every mirror fails, until we keep only the best partial plus the
  // files this run started with.
  const failedTouches: { files: string[]; segs: number }[] = [];
  let attemptError: unknown = null;
  let downloaded = false;
  let retrySame = false;

  const refreshCandidate = async (index: number) => {
    try {
      const again = await resolveStreamPlaylist({
        source,
        type: req.type,
        tmdbId: req.tmdbId,
        season: req.season,
        episode: req.episode,
        signal,
      });
      if (!again.playlistUrl) return;
      // Refresh only this slot. Replacing the whole list mid-loop skips mirrors.
      mirrorCandidates[index] = again.playlistUrl;
    } catch (e) {
      if (signal.aborted) throw e;
    }
  };

  const keepGoing = (e: unknown): boolean => {
    if (e instanceof AuthRefresh) return true;
    if (e instanceof PieceDownloadError) {
      return e.reason === "dead" || e.reason === "auth";
    }
    const msg = e instanceof Error ? e.message : "";
    if (/not available in|no playable quality|no video segments|no audio track/i.test(msg)) {
      return true;
    }
    return !isHardDownloadError(msg);
  };

  for (let mi = 0; mi < mirrorCandidates.length && !downloaded; mi++) {
    throwIfAborted();
    const isRetry = retrySame;
    retrySame = false;
    let m: MirrorParse;
    try {
      m = await tryMirror(mirrorCandidates[mi]!);
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof PieceDownloadError && (e.reason === "network" || e.reason === "quota")) {
        throw e;
      }
      const auth =
        e instanceof AuthRefresh ||
        (e instanceof PieceDownloadError && e.reason === "auth");
      if (auth && !isRetry) {
        retrySame = true;
        await refreshCandidate(mi);
        mi--;
        continue;
      }
      if (!keepGoing(e)) throw e;
      attemptError = e;
      continue;
    }
    try {
      activeMirrorUrl = mirrorCandidates[mi] ?? null;
      await downloadAttempt(m);
      downloaded = true;
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof PieceDownloadError && (e.reason === "network" || e.reason === "quota")) {
        throw e;
      }
      if (e instanceof AuthRefresh && !isRetry) {
        retrySame = true;
        await refreshCandidate(mi);
        mi--;
        continue;
      }
      if (!keepGoing(e)) throw e;
      failedTouches.push({ files: [...touched], segs: doneSeg });
      attemptError = e;
    }
  }
  if (!downloaded) {
    let best: { files: string[]; segs: number } | null = null;
    for (const t of failedTouches) {
      if (!best || t.segs > best.segs) best = t;
    }
    const keep = new Set<string>([...seedFiles, ...(best?.files ?? [])]);
    for (const u of [...fileUrls]) {
      if (keep.has(u)) continue;
      await enqueueCache(() => cache.delete(u).catch(() => false));
      fileUrls.delete(u);
    }
    rec.fileUrls = [...fileUrls];
    if (best && best.segs > rec.doneSegments) rec.doneSegments = best.segs;
    await checkpointRecord();
    const err =
      attemptError instanceof Error
        ? attemptError
        : new Error("Stream lookup failed.");
    if (mirrorCandidates.length > 1 && !(err instanceof PieceDownloadError)) {
      throw new Error(`${err.message} (tried ${mirrorCandidates.length} mirrors)`);
    }
    throw err;
  }
}

async function fetchDownloadSubs(
  req: DownloadRequest,
  imdbId: string | null,
  signal: AbortSignal
): Promise<{ vtt: string; label: string; fileId?: SubFileId } | null> {
  const settings = loadVixSettings();
  const subSource = settings.subSource;
  if (subSource === "off" || subSource === "stream") return null;
  if (signal.aborted) throw abortError();
  if (subSource === "vdrk" || subSource === "auto") {
    const vdrk = await fetchExternalVtt({
      source: "vdrk",
      type: req.type,
      tmdbId: req.tmdbId,
      season: req.season,
      episode: req.episode,
      signal,
    });
    if (vdrk?.vtt) return { vtt: vdrk.vtt, label: vdrk.label };
    if (subSource === "vdrk") return null;
  }
  if (subSource === "subdl") {
    const dl = await fetchExternalVtt({
      source: "subdl",
      type: req.type,
      tmdbId: req.tmdbId,
      imdbId,
      season: req.season,
      episode: req.episode,
      signal,
    });
    if (dl?.vtt) return { vtt: dl.vtt, label: dl.label, fileId: dl.fileId };
    return null;
  }
  // Auto / opensub → OpenSubtitles (needs IMDb)…
  if (imdbId) {
    if (signal.aborted) throw abortError();
    const os = await fetchExternalVtt({
      source: "opensub",
      imdbId,
      season: req.season,
      episode: req.episode,
      signal,
    });
    if (os?.vtt) return { vtt: os.vtt, label: os.label, fileId: os.fileId };
    if (subSource === "opensub") return null;
  } else if (subSource === "opensub") {
    return null;
  }
  // …then SubDL: Auto's last tier, and the only tier that works with no IMDb.
  if (signal.aborted) throw abortError();
  const dl = await fetchExternalVtt({
    source: "subdl",
    type: req.type,
    tmdbId: req.tmdbId,
    imdbId,
    season: req.season,
    episode: req.episode,
    signal,
  });
  if (dl?.vtt) return { vtt: dl.vtt, label: dl.label, fileId: dl.fileId };
  return null;
}

/** VTT files bigger than this are skipped as alternates (outliers). */
const MAX_ALT_VTT_BYTES = 500 * 1024;

/**
 * Up to 2 spare OpenSubtitles files (best + 2 alts total per user choice)
 * so a misaligned default can be swapped offline. Never throws, never fails
 * the download; honors abort between files.
 */
async function fetchDownloadSubAlts(
  req: DownloadRequest,
  imdbId: string | null,
  excludeFileId: SubFileId | undefined,
  signal: AbortSignal
): Promise<{ vtt: string; label: string }[]> {
  const out: { vtt: string; label: string }[] = [];
  if (!imdbId) return out;
  try {
    const q = new URLSearchParams({ imdbId, lang: "en", list: "1" });
    if (req.season != null) q.set("season", String(req.season));
    if (req.episode != null) q.set("episode", String(req.episode));
    const res = await fetch(`/api/vixsrc/subs?${q.toString()}`, { signal });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      items?: { fileId: number; label: string }[];
    };
    for (const item of data.items ?? []) {
      if (out.length >= 2) break;
      if (item.fileId === excludeFileId) continue;
      if (signal.aborted) throw abortError();
      try {
        const ext = await fetchExternalVtt({
          source: "opensub",
          imdbId,
          season: req.season,
          episode: req.episode,
          fileId: item.fileId,
          label: item.label,
          signal,
        });
        if (ext?.vtt && ext.vtt.length <= MAX_ALT_VTT_BYTES) {
          out.push({ vtt: ext.vtt, label: ext.label });
        }
      } catch {
        /* one bad file skips — the rest still land */
      }
    }
  } catch {
    /* alts are a bonus */
  }
  return out;
}

/**
 * Top 2 SubDL files — fetched for EVERY download, whatever the picker says,
 * so the offline item always carries the two best SubDL results as spares
 * alongside the default. List mode costs no download quota; each file fetch
 * does, so a miss just yields fewer spares. Never throws.
 */
async function fetchDownloadSubDlAlts(
  req: DownloadRequest,
  imdbId: string | null,
  excludeFileId: SubFileId | undefined,
  signal: AbortSignal
): Promise<{ vtt: string; label: string }[]> {
  const out: { vtt: string; label: string }[] = [];
  if (!req.tmdbId && !imdbId) return out;
  try {
    const q = new URLSearchParams({
      lang: "en",
      list: "1",
      type: req.type === "tv" ? "tv" : "movie",
    });
    if (req.tmdbId) q.set("tmdbId", String(req.tmdbId));
    if (imdbId) q.set("imdbId", imdbId);
    if (req.season != null) q.set("season", String(req.season));
    if (req.episode != null) q.set("episode", String(req.episode));
    const res = await fetch(`/api/subdl?${q.toString()}`, { signal });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      items?: { fileId: SubFileId; label: string }[];
    };
    for (const item of data.items ?? []) {
      if (out.length >= 2) break;
      if (item.fileId === excludeFileId) continue;
      if (signal.aborted) throw abortError();
      try {
        const ext = await fetchExternalVtt({
          source: "subdl",
          type: req.type,
          tmdbId: req.tmdbId,
          imdbId,
          season: req.season,
          episode: req.episode,
          fileId: item.fileId,
          label: item.label,
          signal,
        });
        if (ext?.vtt && ext.vtt.length <= MAX_ALT_VTT_BYTES) {
          out.push({ vtt: ext.vtt, label: ext.label });
        }
      } catch {
        /* one bad file skips — the rest still land */
      }
    }
  } catch {
    /* alts are a bonus */
  }
  return out;
}

/** Conservative bitrate per quality when the playlist hides bandwidth (single-variant). */
function fallbackBitrateBps(quality: DownloadRecord["quality"]): number {
  switch (quality) {
    case 480:
      return 2_000_000;
    case 720:
      return 4_000_000;
    case 1080:
    case "best":
      return 8_000_000;
  }
}

async function enforceQuota(rec: DownloadRecord, signal: AbortSignal): Promise<void> {
  const settings = loadVixSettings();
  const capBytes = settings.downloadCapMb * 1024 * 1024;
  const all = getAllSync();
  // Zero estimate (single-variant playlist) must not skip accounting: fall
  // back to quality × duration so LRU + headroom still apply.
  const need =
    rec.estimateBytes > 0
      ? rec.estimateBytes
      : rec.durationSec > 0
        ? Math.round((fallbackBitrateBps(rec.quality) * rec.durationSec) / 8)
        : 0;

  // LRU: evict oldest finished downloads until the estimate fits the cap.
  // `used` counts finished bytes PLUS in-progress partials (bytesDone of
  // active/paused/queued/error rows approximates their cache footprint), so
  // concurrent downloads can't overshoot the cap together. Two tiers: old
  // downloads go first, recently-used ones only as a last resort, and the
  // download being played right now is never a victim.
  if (need > 0) {
    // Exclude this row's own footprint: `need` covers it in full, so
    // counting bytesDone/sizeBytes again double-counted the running row
    // (refused early and evicted more than necessary).
    const own = rec.state === "done" ? rec.sizeBytes : Math.max(0, rec.bytesDone || 0);
    let used = Math.max(0, usedBytes(all) - own);
    const now = Date.now();
    const done = all.filter(
      (r) => r.state === "done" && r.key !== rec.key && !isPlaybackInUse(r.key)
    );
    const rank = (a: DownloadRecord, b: DownloadRecord) => a.lastUsedAt - b.lastUsedAt;
    const victims = [
      ...done.filter((r) => now - r.lastUsedAt >= RECENT_USE_FLOOR_MS).sort(rank),
      ...done.filter((r) => now - r.lastUsedAt < RECENT_USE_FLOOR_MS).sort(rank),
    ];
    const refuse = () =>
      new Error(
        `Needs ~${formatBytes(need)} — free space or raise the cap in Download settings.`
      );
    // Feasibility first: if the whole evictable library still can't hold
    // this download, refuse BEFORE evicting. The old loop deleted every
    // victim and only then threw — one oversized request destroyed the
    // entire offline library just to learn "doesn't fit".
    const freeable = victims.reduce((sum, v) => sum + v.sizeBytes, 0);
    if (used - freeable + need > capBytes) throw refuse();
    for (const v of victims) {
      if (signal.aborted) throw abortError();
      if (used + need <= capBytes) break;
      await deleteRecordFiles(v);
      await removeRecord(v.key);
      used -= v.sizeBytes;
    }
    if (used + need > capBytes) throw refuse();
  }

  // Device headroom (best-effort — the OS has the final word).
  try {
    const stats = await storageStats();
    if (
      need > 0 &&
      stats.quota != null &&
      stats.usage != null &&
      stats.usage + need > stats.quota
    ) {
      throw new Error("Not enough device storage for this download.");
    }
    await ensurePersisted().catch(() => false);
  } catch (e) {
    if (e instanceof Error && /device storage/.test(e.message)) throw e;
  }
}
