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
  commitRecord,
  deleteRecordFiles,
  downloadKey,
  ensurePersisted,
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
  dlFileUrl,
  dlPlaylistUrl,
  estimateBytes,
  isMasterPlaylist,
  minVariantHeight,
  parseMasterAudio,
  parseMasterVariants,
  parseMediaPlaylist,
  pickAudioEntry,
  pickVariant,
  rewritePlaylistForOffline,
  type AudioEntry,
  type MediaParts,
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

export function isDownloadActive(key: string): boolean {
  return activeControllers.has(key);
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/**
 * A segment/key piece that failed persistently (bad status after retries,
 * empty body, stall). Mirror-level failure: the download may continue on the
 * next mirror. Anything else (abort, quota, device space) propagates.
 */
class PieceDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PieceDownloadError";
  }
}

/** Per-piece network ceiling: a hung connection must fail, never freeze. */
const PIECE_TIMEOUT_MS = 30000;
/** No completed piece for this long with work remaining = stalled. */
const STALL_TIMEOUT_MS = 60000;
/** Upstream rate limits (429s from loupeandlattice-style hosts) back off here. */
const RETRYABLE_STATUS = (status: number) => status === 429 || status >= 500;
const RETRY_TRIES = 5;
const RETRY_BASE_MS = 800;

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

/**
 * fetchPiece with bounded retries for retryable statuses (429/5xx).
 * Honors Retry-After when served, else exponential backoff + jitter.
 * Returns the LAST response so callers keep their specific error messages;
 * aborts still throw AbortError immediately (pause/cancel path untouched).
 */
async function fetchPieceRetry(
  input: string,
  signal: AbortSignal,
  tries = RETRY_TRIES
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw abortError();
    const res = await fetchPiece(input, signal);
    if (res.ok) return res;
    last = res;
    if (!RETRYABLE_STATUS(res.status) || attempt + 1 >= tries) break;
    // Drain only when actually backing off — a terminal 404 must not pay
    // for a body nobody reads.
    try {
      await res.arrayBuffer();
    } catch {
      /* body already consumed or errored — nothing to free */
    }
    const wait =
      retryAfterMs(res.headers.get("retry-after")) ??
      Math.min(RETRY_BASE_MS * 2 ** attempt, 8000) + Math.random() * 400;
    // Abort-aware backoff: pause/cancel during the wait stops immediately.
    // Listener is removed on every path (no accumulation across retries).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      const onAbort = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return last as Response;
}

/**
 * fetch with a timeout that never masquerades as a user pause/cancel:
 * parent-signal aborts rethrow as AbortError (pause path); timeouts throw a
 * plain Error (error state + retry path).
 */
async function fetchPiece(input: string, signal: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(PIECE_TIMEOUT_MS);
  try {
    return await fetch(input, { signal: AbortSignal.any([signal, timeout]) });
  } catch (err) {
    if (signal.aborted) throw abortError();
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("A piece stalled — tap to retry");
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
  };
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
      await deleteRecordFiles(rec);
      await removeRecord(key);
      return;
    }
    const live = getRecordSync(key) ?? (await getManifest())[key];
    // Deleted or finished elsewhere — never resurrect or clobber.
    if (!live || live.state === "done") return;
    if (live.state === "paused" || (ownedHere && cancelled && pauseIntents.has(key))) {
      pauseIntents.delete(key);
      await commitRecord({ ...rec, state: "paused", error: undefined });
      return;
    }
    // Another live loop owns this key now — hands off, don't clobber it.
    if (!ownedHere) return;
    // Offline interruption (not a real failure): flag for online auto-retry
    // instead of stranding in error. navigator.onLine is advisory — the flag
    // only gates a resume attempt, which re-verifies everything anyway.
    const offline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    await commitRecord({
      ...rec,
      state: "error",
      error: err instanceof Error ? err.message : "Download failed",
      interruptedOffline: offline || undefined,
    });
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
  pauseIntents.add(key);
  const controller = activeControllers.get(key);
  if (controller) {
    controller.abort();
    return;
  }
  pauseIntents.delete(key);
  const rec = getRecordSync(key) ?? (await getManifest())[key];
  if (rec && (rec.state === "active" || rec.state === "queued")) {
    await commitRecord({ ...rec, state: "paused", error: undefined });
  }
}

export async function resumeDownload(req: DownloadRequest): Promise<void> {
  const key = downloadKey(
    req.type === "movie" ? "movie" : "episode",
    req.tmdbId,
    req.season,
    req.episode
  );
  // Consume any stale pause intent so the fresh loop can't trip on it.
  pauseIntents.delete(key);
  const rec = getRecordSync(key);
  if (rec && rec.state !== "done") {
    await upsertRecord({ ...rec, state: "queued", error: undefined });
  }
  return startDownload(req);
}

let autoRetryInit = false;

/**
 * Resume offline-interrupted downloads when connectivity returns. Only rows
 * flagged interruptedOffline (failed while navigator.onLine === false) are
 * retried — genuine errors still need a manual tap. Idempotent.
 */
export function initDownloadAutoRetry(): void {
  if (autoRetryInit || typeof window === "undefined") return;
  autoRetryInit = true;
  const retry = () => {
    void (async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const all = getAllSync();
      for (const rec of all) {
        if (rec.state !== "error" || !rec.interruptedOffline) continue;
        if (activeControllers.has(rec.key) || startingKeys.has(rec.key)) continue;
        try {
          await resumeDownload({
            type: rec.type === "movie" ? "movie" : "tv",
            tmdbId: rec.tmdbId,
            season: rec.season,
            episode: rec.episode,
            title: rec.title,
            subtitle: rec.subtitle,
          });
        } catch {
          /* next reconnect retries again */
        }
      }
    })();
  };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) retry();
  });
}

export function cancelDownload(key: string) {
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
    const masterRes = await fetchPieceRetry(playlistBase, signal);
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
      const vRes = await fetchPieceRetry(pickedVariant.url, signal);
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
        const aRes = await fetchPieceRetry(audioEntry.url, signal);
        if (!aRes.ok) throw new Error(`Audio track fetch failed (${aRes.status})`);
        let aText = await aRes.text();
        audioUrl = audioEntry.url;
        if (isMasterPlaylist(aText)) {
          const aVars = parseMasterVariants(aText, audioEntry.url);
          if (aVars.length === 0) {
            throw new Error("No audio track found for this title.");
          }
          const aPicked = aVars[0]!;
          const avRes = await fetchPieceRetry(aPicked.url, signal);
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
  // Subtitles overlap the segment downloads (same 30s total budget as a
  // sequential fetch, but off the critical path): a hung subs fetch resolves
  // to null instead of parking a finished video at 99%.
  const subsSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
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

  const readSize = (r: Response | undefined): number => {
    const n = Number(r?.headers.get("Content-Length") ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

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
      ...(estimatePatch != null ? { estimateBytes: estimatePatch } : {}),
    });
  };

  const storeParts = async (
    list: MediaParts,
    label: string
  ): Promise<string[]> => {
    // Segments dead upstream (persistently empty, or a status failure after
    // retries) become EXT-X-GAP entries instead of killing the title — a few
    // dead chunks out of hundreds must not fail an episode. Capped: past the
    // cap the mirror is declared bad (failover) rather than Swiss cheese.
    const gaps = new Set<string>();
    const MAX_GAPS = 8;
    // Gap a persistently dead piece, or throw when the cap is exhausted.
    const gapOrThrow = async (dlUrl: string, err: PieceDownloadError): Promise<boolean> => {
      if (gaps.size >= MAX_GAPS) throw err;
      gaps.add(dlUrl);
      doneSeg++;
      await reportProgress();
      return true;
    };
    const jobs: { original: string; dlUrl: string; kind: "seg" | "key"; segNo: number }[] = [];
    if (list.mapUrl) {
      jobs.push({
        original: list.mapUrl,
        dlUrl: dlFileUrl(canonicalMediaKey(list.mapUrl)),
        kind: "key",
        segNo: 0,
      });
    }
    for (const k of list.keys) {
      jobs.push({
        original: k.url,
        dlUrl: dlFileUrl(canonicalMediaKey(k.url)),
        kind: "key",
        segNo: 0,
      });
    }
    // Segment numbers assigned at build time (1-based, playlist order) —
    // workers fetch concurrently, so a runtime counter would mislabel.
    let segTotalCount = 0;
    for (const s of list.segments) {
      segTotalCount++;
      jobs.push({
        original: s,
        dlUrl: dlFileUrl(canonicalMediaKey(s)),
        kind: "seg",
        segNo: segTotalCount,
      });
    }
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        throwIfAborted();
        // Durable reconcile: pause/delete from another tab (or a lost
        // controller map) must stop this loop even though no local signal
        // fired. Cheap sync mirror read per iteration.
        const live = getRecordSync(rec.key);
        if (!live || live.state === "paused") throw abortError();
        // Stall watchdog: all workers hung with jobs left used to freeze
        // the bar at its last percent forever with no error state.
        // Mirror-switchable (a hung mirror is a dead mirror) — see attempts.
        if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
          throw new PieceDownloadError("Stalled — tap to retry");
        }
        const i = cursor++;
        if (i >= jobs.length) return;
        const job = jobs[i]!;
        const hit = await cache.match(job.dlUrl);
        if (hit) {
          fileUrls.add(job.dlUrl);
          if (job.kind === "seg") {
            doneSeg++;
            measuredBytes += readSize(hit);
            await reportProgress();
          }
          continue;
        }
        // 1-based position among segments only (keys/init are not counted).
        const segNo = job.segNo;
        const segTotal = segTotalCount;
        const fail = (msg: string): PieceDownloadError =>
          new PieceDownloadError(
            job.kind === "seg" && segNo > 0
              ? `${label} segment ${segNo}/${segTotal} ${msg}`
              : `${label} piece ${msg}`
          );
        const res = await fetchPieceRetry(job.original, signal, 3);
        if (!res.ok) {
          // Same-origin pieces fail with JSON bodies ("bad signature" = our
          // layer, "upstream N" = theirs) — surface it so a 403 is instantly
          // attributable instead of a bare status. Body is single-read.
          let detail = "";
          try {
            const data = (await res.json()) as { error?: unknown };
            if (typeof data?.error === "string" && data.error.length > 0) {
              detail = `: ${data.error.slice(0, 120)}`;
            }
          } catch {
            /* binary upstream body — status alone */
          }
          const err = fail(`failed (${res.status}${detail}).`);
          // Dead chunk (not auth-wide: siblings succeed) → gap it. Keys and
          // init maps can't gap — those still fail the download.
          if (job.kind === "seg") {
            await gapOrThrow(job.dlUrl, err);
            continue;
          }
          throw err;
        }
        // Empty 200s happen (dead file on the CDN, not a flaky network):
        // re-fetch twice, then gap the chunk (segments) instead of failing.
        let buf: ArrayBuffer | null = await res.arrayBuffer();
        for (let retry = 0; retry < 2 && buf.byteLength === 0; retry++) {
          const res2 = await fetchPieceRetry(job.original, signal, 2);
          if (!res2.ok) {
            let detail = "";
            try {
              const data = (await res2.json()) as { error?: unknown };
              if (typeof data?.error === "string" && data.error.length > 0) {
                detail = `: ${data.error.slice(0, 120)}`;
              }
            } catch {
              /* binary upstream body — status alone */
            }
            const err = fail(`failed (${res2.status}${detail}).`);
            if (job.kind === "seg") {
              await gapOrThrow(job.dlUrl, err);
              buf = null;
              break;
            }
            throw err;
          }
          buf = await res2.arrayBuffer();
        }
        if (buf == null) continue; // gapped above
        if (buf.byteLength === 0) {
          const err = fail(`was empty.`);
          if (job.kind === "seg") {
            await gapOrThrow(job.dlUrl, err);
            continue;
          }
          throw err;
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
          await cache.put(job.dlUrl, stored);
        } catch (e) {
          if (
            e instanceof DOMException &&
            (e.name === "QuotaExceededError" || e.code === 22)
          ) {
            throw new Error("Out of device space — free storage and retry.");
          }
          throw e;
        }
        fileUrls.add(job.dlUrl);
        if (job.kind === "seg") {
          doneSeg++;
          measuredBytes += buf.byteLength;
          await reportProgress();
        }
        throwIfAborted();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker())
    );
    return [...gaps];
  };

  /**
   * One full download attempt against a single parsed mirror: estimate →
   * quota → segments → playlists → subs → done. Throws PieceDownloadError
   * for persistent piece failures (caller switches mirrors); anything else
   * (abort, quota, device space) propagates.
   */
  const downloadAttempt = async (m: MirrorParse): Promise<void> => {
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

    const videoGaps = await storeParts(m.parts, "Video");
    throwIfAborted();
    const audioGaps = m.audioParts ? await storeParts(m.audioParts, "Audio") : [];
    throwIfAborted();

    // 6. Store rewritten playlists last — only complete sets ever play.
    // Dead chunks ride as EXT-X-GAP entries (players skip them) instead of
    // missing files that would stall playback.
    const videoStoredUrl = dlFileUrl(canonicalMediaKey(m.mediaUrl));
    await cache.put(
      videoStoredUrl,
      mpegResponse(rewritePlaylistForOffline(m.mediaText, m.mediaUrl, new Set(videoGaps)))
    );
    fileUrls.add(videoStoredUrl);
    let topText: string;
    if (m.audioParts && m.audioUrl && m.audioText && m.audioEntry && m.pickedVariant) {
      const audioStoredUrl = dlFileUrl(canonicalMediaKey(m.audioUrl));
      await cache.put(
        audioStoredUrl,
        mpegResponse(rewritePlaylistForOffline(m.audioText, m.audioUrl, new Set(audioGaps)))
      );
      fileUrls.add(audioStoredUrl);
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
    await cache.put(playlistKey, mpegResponse(topText, true));
    fileUrls.add(playlistKey);
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
    rec.state = "done";
    rec.error = undefined;
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

  // Attempts walk mirrors in order: a persistently poisoned piece (same
  // segment 403/empty on every retry) discards the attempt's files, resets
  // counters, and continues on the next mirror. Single-mirror sources
  // attempt once — behavior identical to before.
  let attemptError: unknown = null;
  let downloaded = false;
  for (let mi = 0; mi < mirrorCandidates.length && !downloaded; mi++) {
    throwIfAborted();
    let m: MirrorParse;
    try {
      m = await tryMirror(mirrorCandidates[mi]!);
    } catch (e) {
      // Pause/cancel aborts the whole download, never the mirror.
      if (signal.aborted) throw e;
      attemptError = e;
      continue;
    }
    const attemptBase = new Set(fileUrls);
    try {
      await downloadAttempt(m);
      downloaded = true;
    } catch (e) {
      if (signal.aborted) throw e;
      if (!(e instanceof PieceDownloadError)) throw e;
      attemptError = e;
      // Drop this attempt's partial files (owned set only) so the next
      // mirror starts clean; shared/resume files (in attemptBase) stay.
      const gone: string[] = [];
      for (const u of fileUrls) {
        if (!attemptBase.has(u)) gone.push(u);
      }
      await Promise.all(gone.map((u) => cache.delete(u).catch(() => false)));
      for (const u of gone) fileUrls.delete(u);
      doneSeg = 0;
      measuredBytes = 0;
      lastProgressAt = Date.now();
      rec.bytesDone = 0;
      rec.doneSegments = 0;
      rec.fileUrls = [...fileUrls];
      await updateProgress(rec.key, {
        bytesDone: 0,
        doneSegments: 0,
        fileUrls: [...fileUrls],
      });
    }
  }
  if (!downloaded) {
    const err =
      attemptError instanceof Error
        ? attemptError
        : new Error("Stream lookup failed.");
    if (mirrorCandidates.length > 1) {
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
