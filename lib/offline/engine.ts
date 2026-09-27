/**
 * Offline download engine (page context).
 *
 * Flow per item: resolve native playlist (vix/goated cascade — iframe
 * sources can never download, the browser never touches their bytes) →
 * pick variant at/below the quality setting → fetch segments + init + keys
 * through the same same-origin paths the player uses → store bytes in the
 * `tvtime-downloads` cache under `/api/dl?u=` keys → store the rewritten
 * playlist under `/api/dl?playlist=` → auto-fetch the subtitle track →
 * mark done. Pause/resume/cancel via per-key AbortControllers; resume
 * skips bytes already in the cache.
 */

import { resolveStreamPlaylist } from "@/lib/player-stream";
import { fetchExternalVtt } from "@/lib/player-subs";
import { fetchSegments } from "@/lib/introdb";
import { loadVixSettings, matchLang } from "@/lib/vix-settings";
import {
  DL_CACHE,
  checkpointRecord,
  commitRecord,
  deleteRecordFiles,
  downloadKey,
  ensurePersisted,
  flushManifest,
  getAllSync,
  getManifest,
  getRecordSync,
  removeRecord,
  storageStats,
  updateProgress,
  upsertRecord,
  usedBytes,
  type DownloadRecord,
} from "@/lib/offline/store";
import {
  buildOfflineMaster,
  canonicalMediaKey,
  classifyPieceStatus,
  dlFileUrl,
  dlPlaylistUrl,
  estimateBytes,
  gapBudget,
  isHardDownloadError,
  isMasterPlaylist,
  minVariantHeight,
  offlinePieceUrl,
  parseMasterAudio,
  parseMasterVariants,
  parseMediaPlaylist,
  pickAudioEntry,
  pickVariant,
  rewritePlaylistForOffline,
  segmentLooksValid,
  type AudioEntry,
  type ByteRange,
  type MediaParts,
  type PieceFailureReason,
  type VariantInfo,
} from "@/lib/offline/hls";
import { formatBytes } from "@/lib/utils";

export type DownloadRequest = {
  type: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  title: string;
  subtitle?: string;
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

/** Keep a requested byte range; never persist a 206 as if it were the whole file. */
function sliceToRange(
  buf: ArrayBuffer,
  status: number,
  range: ByteRange | null
): ArrayBuffer {
  if (!range) return buf;
  if (status === 200 && buf.byteLength >= range.start + range.length) {
    return buf.slice(range.start, range.start + range.length);
  }
  if (buf.byteLength > range.length) return buf.slice(0, range.length);
  return buf;
}

async function cachedPieceOk(
  res: Response,
  job: { kind: "seg" | "key" | "init"; encrypted: boolean }
): Promise<number> {
  try {
    const blob = await res.clone().blob();
    if (blob.size <= 0) return 0;
    if (job.kind === "key" && blob.size !== 16) return 0;
    const prefix = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
    const kind = job.kind === "init" ? "init" : job.kind === "key" ? "key" : "seg";
    if (!segmentLooksValid(prefix, kind, job.encrypted)) return 0;
    if (!job.encrypted && kind === "seg" && prefix[0] === 0x47 && blob.size < 188) return 0;
    return blob.size;
  } catch {
    return 0;
  }
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
 */
function diagnoseResolveFailure(r: {
  code?: string;
  detail?: string;
  attempts?: Array<{ source: string; ok: boolean; error?: string }>;
}): string {
  if (r.code === "resolver_unconfigured") {
    return "Downloads need the stream resolver — VIX_RESOLVER_URL isn't set on this deployment, and the sources block it directly. Streaming still works via embeds, but offline needs native. Set the env var and redeploy.";
  }
  if (r.code === "resolution_failed") {
    return `Stream resolver failed${r.detail ? ` (${r.detail})` : ""} If it names the resolver, revive/redeploy that service (its /health should return ok), check VIX_RESOLVER_URL, then retry.`;
  }
  if (r.code === "upstream_unreachable") {
    return "Sources are unreachable from this deployment right now. Retry in a bit — embed streaming is unaffected.";
  }
  const tried = (r.attempts ?? [])
    .filter((a) => !a.ok)
    .map((a) => a.source)
    .join(", ");
  return `No downloadable stream${tried ? ` (tried: ${tried})` : ""} — the title may only exist on embed sources right now.`;
}

export async function startDownload(req: DownloadRequest): Promise<void> {
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
    return await startDownloadInner(req, key);
  } finally {
    startingKeys.delete(key);
    pumpQueue();
  }
}

async function startDownloadInner(req: DownloadRequest, key: string): Promise<void> {
  const settings = loadVixSettings();
  if (!settings.downloadMode) {
    throw new Error("Download mode is off — enable it in Download settings.");
  }
  const existing = getRecordSync(key) ?? (await getManifest())[key];
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
  if (existing && existing.fileUrls.length > 0 && !sameQuality) {
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
    quality: settings.downloadQuality,
    usedSource: existing?.usedSource ?? "",
    durationSec: existing?.durationSec ?? 0,
    estimateBytes: existing?.estimateBytes ?? 0,
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
  };
  // iPhone can't run two titles at once without getting the tab killed.
  if (isIosSafari() && otherSlotTaken(key)) {
    if (!iosQueue.some((r) => requestKey(r) === key)) iosQueue.push(req);
    rec.state = "queued";
    await upsertRecord(rec);
    return;
  }
  await upsertRecord(rec);

  const controller = new AbortController();
  activeControllers.set(key, controller);
  try {
    await runDownload(req, rec, controller.signal);
  } catch (err) {
    // Stop straggler workers still burning data after the first failure.
    // (Pause/cancel paths already aborted; this is a no-op for them.)
    controller.abort();
    const cancelled = controller.signal.aborted;
    // Identity, not just presence: another tab/session may have registered
    // its own controller under this key after ours died.
    const ownedHere = activeControllers.get(key) === controller;
    if (cancelIntents.has(key)) {
      cancelIntents.delete(key);
      pauseIntents.delete(key);
      systemPauseKeys.delete(key);
      clearAutoResume(key);
      dequeueIos(key);
      await deleteRecordFiles(rec);
      await removeRecord(key);
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
    return;
  }
  pauseIntents.delete(key);
  const rec = getRecordSync(key) ?? (await getManifest())[key];
  if (rec && (rec.state === "active" || rec.state === "queued")) {
    await commitRecord({ ...rec, state: "paused", error: undefined, retryable: false });
  }
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

function reqFromRecord(rec: DownloadRecord): DownloadRequest {
  return {
    type: rec.type === "movie" ? "movie" : "tv",
    tmdbId: rec.tmdbId,
    season: rec.season,
    episode: rec.episode,
    title: rec.title,
    subtitle: rec.subtitle,
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
    await startDownload(reqFromRecord(rec));
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
    void continueAutomatic(rec);
  }, delay);
  autoResumeTimers.set(key, timer);
}

function pumpQueue(): void {
  if (typeof document !== "undefined" && document.hidden) return;
  if (activeControllers.size > 0 || startingKeys.size > 0) return;
  if (isIosSafari() && iosQueue.length > 0) {
    const next = iosQueue.shift();
    if (next) {
      void startDownload(next);
      return;
    }
  }
  void continueNextEligible();
}

function pauseForBackground(): void {
  for (const [key, controller] of activeControllers) {
    systemPauseKeys.add(key);
    pauseIntents.add(key);
    controller.abort();
  }
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
            await startDownload(next);
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
  window.addEventListener("pagehide", pauseForBackground);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseForBackground();
    else onVisible();
  });
}

export function cancelDownload(key: string) {
  clearAutoResume(key);
  dequeueIos(key);
  systemPauseKeys.delete(key);
  if (!activeControllers.has(key)) {
    // Not running — just drop the row + files.
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
  clearAutoResume(key);
  dequeueIos(key);
  systemPauseKeys.delete(key);
  cancelIntents.delete(key);
  pauseIntents.delete(key);
  activeControllers.get(key)?.abort();
  activeControllers.delete(key);
  const rec = getRecordSync(key);
  if (rec) await deleteRecordFiles(rec);
  await removeRecord(key);
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

  // 1. Resolve a native playlist (vix/goated/vidsrc-sh cascade).
  const preferred = loadVixSettings().preferredSource;
  const source = preferred === "vix" || preferred === "goated" ? preferred : "goated";
  const resolved = await resolveStreamPlaylist({
    source,
    type: req.type,
    tmdbId: req.tmdbId,
    season: req.season,
    episode: req.episode,
    signal,
  });
  throwIfAborted();
  if (!resolved.playlistUrl) {
    throw new Error(diagnoseResolveFailure(resolved));
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
  const mirrorCandidates =
    resolved.usedSource === "vidsrc-sh" &&
    Array.isArray(resolved.playlistUrls) &&
    resolved.playlistUrls.length > 1
      ? resolved.playlistUrls
      : [resolved.playlistUrl];
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
    };
  };
  // Refined per attempt (bandwidth differs per mirror) — see downloadAttempt.
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
    let alts: { vtt: string; label: string }[] = [];
    const subOpts = loadVixSettings().subSource;
    if (subOpts === "vdrk" || subOpts === "auto" || subOpts === "opensub") {
      const fetched = await fetchDownloadSubAlts(
        req,
        resolved.imdbId,
        sub?.fileId,
        subsSignal
      );
      alts = fetched;
    }
    const entries = [
      ...(sub ? [{ vtt: sub.vtt, label: sub.label }] : []),
      ...alts,
    ].slice(0, 3);
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
  let measuredBytes = 0;

  const mpegResponse = (text: string, noStore = false) =>
    new Response(text, {
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
    // Fallback estimates (bandwidth unknown) converge on measured reality:
    // total ≈ measured / fraction-complete, adopted once past warmup and
    // only when it disagrees by >20% (avoids jitter on uniform segments).
    let estimatePatch: number | null = null;
    if (
      refineEstimate &&
      doneSeg >= 6 &&
      rec.totalSegments > 0 &&
      rec.estimateBytes > 0
    ) {
      const frac = doneSeg / rec.totalSegments;
      if (frac >= 0.08 && frac < 1) {
        const refined = Math.round(measuredBytes / frac);
        if (
          refined > 0 &&
          Math.abs(refined - rec.estimateBytes) / rec.estimateBytes > 0.2
        ) {
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
      doneSegments: doneSeg,
      fileUrls: rec.fileUrls,
      ...(estimatePatch != null ? { estimateBytes: estimatePatch } : {}),
    });
  };

  type PieceJob = {
    original: string;
    dlUrl: string;
    kind: "seg" | "key" | "init";
    segNo: number;
    range: ByteRange | null;
    encrypted: boolean;
  };

  const rememberFile = (url: string) => {
    fileUrls.add(url);
    touched.add(url);
  };

  /**
   * Fetch every init, key, and segment. Dead video segments become gaps
   * (under the budget). Expired links throw AuthRefresh so the caller can
   * refetch the playlist without deleting finished pieces. Network stalls
   * throw PieceDownloadError("network") and keep every byte already stored.
   */
  const storeParts = async (
    list: MediaParts,
    label: string,
    authAsDead: boolean
  ): Promise<string[]> => {
    const gaps = new Set<string>();
    const budget = gapBudget(list.segments.length);
    const jobs: PieceJob[] = [];
    const seenMeta = new Set<string>();
    for (const map of list.maps) {
      const dlUrl = offlinePieceUrl(map.url, map.byteRange);
      if (seenMeta.has(dlUrl)) continue;
      seenMeta.add(dlUrl);
      jobs.push({
        original: map.url,
        dlUrl,
        kind: "init",
        segNo: 0,
        range: map.byteRange,
        encrypted: false,
      });
    }
    for (const k of list.keys) {
      if (k.method === "NONE") continue;
      const dlUrl = offlinePieceUrl(k.url, null);
      if (seenMeta.has(dlUrl)) continue;
      seenMeta.add(dlUrl);
      jobs.push({
        original: k.url,
        dlUrl,
        kind: "key",
        segNo: 0,
        range: null,
        encrypted: false,
      });
    }
    let segTotalCount = 0;
    for (const s of list.segments) {
      segTotalCount++;
      jobs.push({
        original: s.url,
        dlUrl: offlinePieceUrl(s.url, s.byteRange),
        kind: "seg",
        segNo: segTotalCount,
        range: s.byteRange,
        encrypted: s.encrypted,
      });
    }

    const pool = new AbortController();
    const stopPool = () => {
      if (!pool.signal.aborted) pool.abort();
    };
    const gapOrThrow = async (dlUrl: string, err: PieceDownloadError) => {
      if (gaps.size >= budget) {
        stopPool();
        throw err;
      }
      gaps.add(dlUrl);
      doneSeg++;
      await reportProgress();
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

        const hit = await cache.match(job.dlUrl);
        if (hit) {
          const size = await cachedPieceOk(hit, job);
          if (size > 0) {
            rememberFile(job.dlUrl);
            if (job.kind === "seg") {
              doneSeg++;
              measuredBytes += size;
              await reportProgress();
            }
            continue;
          }
          await enqueueCache(() => cache.delete(job.dlUrl));
        }

        let res: Response;
        try {
          res = await fetchPieceRetry(job.original, signal, pool.signal, job.range, 5);
        } catch (err) {
          if (err instanceof PoolStopped) return;
          if (!(err instanceof PieceDownloadError)) throw err;
          if (err.reason === "auth" && !(authAsDead && job.kind === "seg")) {
            stopPool();
            throw new AuthRefresh();
          }
          if (err.reason === "network") {
            stopPool();
            throw err;
          }
          const dead = fail(err.message, "dead");
          if (job.kind === "seg") {
            await gapOrThrow(job.dlUrl, dead);
            continue;
          }
          stopPool();
          throw dead;
        }

        let buf = await res.arrayBuffer();
        buf = sliceToRange(buf, res.status, job.range);
        if (buf.byteLength === 0) {
          // One more try — CDNs sometimes answer 200 with an empty body.
          try {
            const res2 = await fetchPieceRetry(job.original, signal, pool.signal, job.range, 2);
            buf = sliceToRange(await res2.arrayBuffer(), res2.status, job.range);
            res = res2;
          } catch (err) {
            if (err instanceof PoolStopped) return;
            if (err instanceof PieceDownloadError && err.reason === "auth" && !(authAsDead && job.kind === "seg")) {
              stopPool();
              throw new AuthRefresh();
            }
            if (err instanceof PieceDownloadError && err.reason === "network") {
              stopPool();
              throw err;
            }
            buf = new ArrayBuffer(0);
          }
        }
        const bytes = new Uint8Array(buf);
        const valid = segmentLooksValid(
          bytes.subarray(0, Math.min(bytes.byteLength, 256)),
          job.kind,
          job.encrypted
        );
        const fullEnough =
          job.kind !== "key" || bytes.byteLength === 16;
        if (!valid || !fullEnough || bytes.byteLength === 0) {
          const dead = fail(
            bytes.byteLength === 0 ? "was empty." : "was not media.",
            "dead"
          );
          if (job.kind === "seg") {
            await gapOrThrow(job.dlUrl, dead);
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
  const downloadAttempt = async (m: MirrorParse, authAsDead: boolean): Promise<void> => {
    doneSeg = 0;
    measuredBytes = 0;
    touched = new Set();
    lastProgressAt = Date.now();
    rec.durationSec = m.parts.durationSec;
    rec.totalSegments =
      m.parts.segments.length + (m.audioParts?.segments.length ?? 0);
    rec.estimateBytes = estimateBytes(m.bandwidth, m.parts.durationSec);
    // Single-variant playlists hide bandwidth (0): the estimate is a quality
    // guess and drifts (e.g. vidsrc-sh). Refined from measured bytes once
    // enough segments land (see reportProgress); real estimates stay.
    refineEstimate = m.bandwidth <= 0;
    await upsertRecord(rec);

    // 4. Quota: device headroom + the 950MB-style self cap (LRU-evict to fit).
    await enforceQuota(rec, signal);

    const videoGaps = await storeParts(m.parts, "Video", authAsDead);
    throwIfAborted();
    const audioGaps = m.audioParts
      ? await storeParts(m.audioParts, "Audio", authAsDead)
      : [];
    throwIfAborted();

    // 6. Store rewritten playlists last — only complete sets ever play.
    // Dead chunks ride as EXT-X-GAP entries (players skip them) instead of
    // missing files that would stall playback.
    const videoStoredUrl = dlFileUrl(canonicalMediaKey(m.mediaUrl));
    await enqueueCache(() =>
      cache.put(
        videoStoredUrl,
        mpegResponse(rewritePlaylistForOffline(m.mediaText, m.mediaUrl, new Set(videoGaps)))
      )
    );
    rememberFile(videoStoredUrl);
    let topText: string;
    const audioUrl = m.audioUrl;
    const audioText = m.audioText;
    if (m.audioParts && audioUrl && audioText && m.audioEntry && m.pickedVariant) {
      const audioStoredUrl = dlFileUrl(canonicalMediaKey(audioUrl));
      await enqueueCache(() =>
        cache.put(
          audioStoredUrl,
          mpegResponse(rewritePlaylistForOffline(audioText, audioUrl, new Set(audioGaps)))
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
      topText = rewritePlaylistForOffline(m.mediaText, m.mediaUrl, new Set(videoGaps));
    }
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

    rec.sizeBytes = measuredBytes;
    rec.bytesDone = measuredBytes;
    rec.state = "done";
    rec.error = undefined;
    rec.retryable = false;
    rec.downloadedAt = Date.now();
    rec.lastUsedAt = Date.now();
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
      await downloadAttempt(m, isRetry);
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
): Promise<{ vtt: string; label: string; fileId?: number } | null> {
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
  if (!imdbId) return null;
  if (signal.aborted) throw abortError();
  const os = await fetchExternalVtt({
    source: "opensub",
    imdbId,
    season: req.season,
    episode: req.episode,
    signal,
  });
  if (os?.vtt) return { vtt: os.vtt, label: os.label, fileId: os.fileId };
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
  excludeFileId: number | undefined,
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
  // concurrent downloads can't overshoot the cap together.
  if (need > 0) {
    let used = usedBytes(all);
    const victims = all
      .filter((r) => r.state === "done" && r.key !== rec.key)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const v of victims) {
      if (signal.aborted) throw abortError();
      if (used + need <= capBytes) break;
      await deleteRecordFiles(v);
      await removeRecord(v.key);
      used -= v.sizeBytes;
    }
    if (used + need > capBytes) {
      throw new Error(
        `Needs ~${formatBytes(need)} — free space or raise the cap in Download settings.`
      );
    }
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
