/**
 * Offline store: download manifest (IndexedDB + sync mirror), Cache Storage
 * accounting, resume positions, and the playback-sync outbox. Single owner
 * of all offline persistence shapes (also read raw by public/offline.html).
 */
import { get, set } from "idb-keyval";
import { dlPlaylistUrl } from "@/lib/offline/hls";
import { RESUME_END_RATIO } from "@/lib/player-constants";
import { isResumablePosition } from "@/lib/player-progress";

export const DL_CACHE = "tvtime-downloads";
const MANIFEST_IDB_KEY = "tvtime-download-manifest-v1";

/**
 * Library thumbnail size. w154 (154×231) is the smallest cut that still
 * holds up on a phone-sized poster tile — a few kilobytes per title.
 */
export const POSTER_SIZE = "w154";

export function posterThumbUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${POSTER_SIZE}${path}`;
}

/**
 * Cache the tiny poster next to the download's bytes — in DL_CACHE, which
 * VERSION bumps never purge, so Library thumbnails survive a service-worker
 * update. Fetched no-cors (TMDB images are loaded as plain <img> elsewhere),
 * so the response is opaque; still perfectly storable and displayable.
 */
export async function cachePosterThumb(
  path: string | null | undefined
): Promise<boolean> {
  const url = posterThumbUrl(path);
  if (!url || typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(DL_CACHE);
    if (await cache.match(url)) return true;
    const res = await fetch(url, { mode: "no-cors", credentials: "omit" });
    await cache.put(url, res);
    return true;
  } catch {
    // Offline or blocked — the row falls back to its placeholder.
    return false;
  }
}

export type DownloadItemType = "movie" | "episode";
export type DownloadState =
  | "queued"
  | "active"
  | "paused"
  | "done"
  | "error"
  | "missing";

export type DownloadRecord = {
  key: string;
  type: DownloadItemType;
  tmdbId: number;
  season?: number;
  episode?: number;
  title: string;
  subtitle?: string;
  /** TMDB poster path — drives the Library thumbnail (see posterThumbUrl). */
  posterPath?: string | null;
  quality: 480 | 720 | 1080 | "best";
  usedSource: string;
  durationSec: number;
  estimateBytes: number;
  /** Measured bytes once complete. */
  sizeBytes: number;
  bytesDone: number;
  totalSegments: number;
  doneSegments: number;
  /** Every Cache Storage key owned by this download (playlist + segments). */
  fileUrls: string[];
  state: DownloadState;
  error?: string;
  /** Auto-downloaded external subtitle (VTT text, kilobytes). */
  subVtt: string | null;
  subLabel: string | null;
  /**
   * Spare OpenSubtitles files (best + up to 2 alternates) for switching
   * when the default misaligns. Each VTT is kilobytes; capped at fetch.
   */
  subAlts: { vtt: string; label: string }[];
  /** IntroDB segments captured at download time (skip works offline). */
  segments: {
    intro: { start: number; end: number } | null;
    recap: { start: number; end: number } | null;
    outro: { start: number; end: number } | null;
  } | null;
  downloadedAt: number;
  /** Touch on play/finish — drives LRU eviction. */
  lastUsedAt: number;
  /**
   * True when the last failure happened while the browser was offline.
   * Cleared on the next manual start.
   */
  interruptedOffline?: boolean;
  /**
   * The run can continue without a tap (stall, background, expired link).
   * Cleared on a manual pause and on a hard error (quota, encryption, quality).
   */
  retryable?: boolean;
  /** Automatic continuations since the last manual start. Stops at 5. */
  autoAttempts?: number;
  /**
   * Signature of the bytes on disk: `height:videoCount|audioCount|
   * subCount` (encodeRendition). Compared per group on every attempt —
   * only the groups whose signature changed are discarded; an identical
   * signature keeps everything.
   */
  rendition?: string;
  /**
   * The mirror (master playlist URL) whose parse produced `rendition`.
   * Signed URLs re-sign on every resolve, so resumes match it by mirror
   * identity (mirrorIdentity) and try that mirror first — flipping mirrors
   * mid-title is a different cut and wipes the bytes on disk.
   */
  usedPlaylistUrl?: string;
  /**
   * Segment indexes a finished run skipped (gap budget, quota). Absent or
   * empty = complete. Keeps `state: "done"` honest: the row can badge
   * "Partial" and a repair run fetches exactly these holes.
   */
  missing?: { role: "v" | "a" | "s"; index: number }[];
};

export function downloadKey(
  type: DownloadItemType,
  tmdbId: number,
  season?: number,
  episode?: number
): string {
  return type === "movie"
    ? `m:${tmdbId}`
    : `e:${tmdbId}:${season ?? 0}:${episode ?? 0}`;
}

let cache: Record<string, DownloadRecord> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastEmitAt = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* subscriber error must not break the engine */
    }
  }
}

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Key of the download currently mounted in the offline player. Quota LRU
 * must never evict the bytes being played — the host sets it on open and
 * clears it on close.
 */
let playbackInUseKey: string | null = null;

export function setPlaybackInUse(key: string | null): void {
  playbackInUseKey = key;
}

export function isPlaybackInUse(key: string): boolean {
  return playbackInUseKey === key;
}

/** Holes a finished download still owes — 0 means truly complete. */
export function missingCount(rec: DownloadRecord): number {
  return rec.state === "done" ? rec.missing?.length ?? 0 : 0;
}

async function load(): Promise<Record<string, DownloadRecord>> {
  if (cache) return cache;
  try {
    cache = (await get<Record<string, DownloadRecord>>(MANIFEST_IDB_KEY)) ?? {};
  } catch (err) {
    // NEVER persist a failed read as an empty manifest: one transient IDB
    // error used to write `{}` back over every download row while the media
    // bytes stayed on disk — rows became unlistable and undeletable. Leaving
    // `cache` null pauses all writes until a read succeeds; callers get a
    // throwaway object for this round only.
    cache = null;
    console.warn("[downloads] manifest read failed — saving paused", err);
    return {};
  }
  return cache;
}

function scheduleSave() {
  if (typeof window === "undefined") return;
  hookPersistence();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (cache) set(MANIFEST_IDB_KEY, cache).catch(() => {});
  }, 400);
}

/** Immediate manifest write (crash/shutdown paths). Fire-and-forget. */
export function flushManifest(): void {
  if (typeof window === "undefined") return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (cache) set(MANIFEST_IDB_KEY, cache).catch(() => {});
}

/**
 * Awaitable manifest write. Called after each newly stored segment so an
 * iOS jetsam (which often skips pagehide) still leaves a resume point.
 */
export async function checkpointRecord(): Promise<void> {
  if (typeof window === "undefined") return;
  hookPersistence();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!cache) return;
  try {
    await set(MANIFEST_IDB_KEY, cache);
  } catch {
    /* best-effort — the debounced save and pagehide flush still run */
  }
}

let persistHooked = false;

/**
 * Flush the debounced manifest when the page hides — a crash or OS kill
 * inside the 400ms window must not lose the latest progress. Registered
 * lazily on first save so non-offline pages pay nothing.
 */
function hookPersistence(): void {
  if (persistHooked || typeof window === "undefined") return;
  persistHooked = true;
  try {
    window.addEventListener("pagehide", flushManifest);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushManifest();
    });
  } catch {
    /* ignore */
  }
}

export async function getManifest(): Promise<Record<string, DownloadRecord>> {
  const m = await load();
  return { ...m };
}

/**
 * Manifest read for the start path. On a failed read load() hands back a
 * throwaway `{}` (writes stay paused) — harmless for callers that only
 * read-and-display, but a start would mistake it for "no record" and
 * rebuild the row from 0%. Same data as getManifest(); rethrows instead.
 */
export async function getManifestStrict(): Promise<Record<string, DownloadRecord>> {
  const m = await load();
  if (!cache) {
    throw new Error("Couldn't read saved downloads — storage may be busy; try again.");
  }
  return { ...m };
}

export function getRecordSync(key: string): DownloadRecord | null {
  return cache?.[key] ?? null;
}

export function getAllSync(): DownloadRecord[] {
  if (!cache) return [];
  return Object.values(cache).sort((a, b) => b.downloadedAt - a.downloadedAt);
}

export async function upsertRecord(rec: DownloadRecord): Promise<void> {
  const m = await load();
  m[rec.key] = rec;
  scheduleSave();
  emit();
}

/**
 * Progress-path update: writes through to the mirror immediately and emits
 * at most ~2×/s so progress rings don't re-render hundreds of times.
 */
export async function updateProgress(
  key: string,
  patch: Partial<DownloadRecord>
): Promise<void> {
  const m = await load();
  const rec = m[key];
  if (!rec) return;
  Object.assign(rec, patch);
  scheduleSave();
  const now = Date.now();
  if (now - lastEmitAt > 500) {
    lastEmitAt = now;
    emit();
  }
}

/** Flush a final state change immediately (done/error/paused). */
export async function commitRecord(rec: DownloadRecord): Promise<void> {
  const m = await load();
  m[rec.key] = rec;
  // `m` is only the persisted manifest when the read succeeded (load()
  // returns a throwaway object otherwise — writing it would wipe rows).
  if (typeof window !== "undefined" && cache && m === cache) {
    try {
      await set(MANIFEST_IDB_KEY, m);
    } catch {
      /* best-effort */
    }
  }
  emit();
}

export async function removeRecord(key: string): Promise<void> {
  const m = await load();
  delete m[key];
  scheduleSave();
  emit();
}

export async function touchRecord(key: string): Promise<void> {
  const m = await load();
  const rec = m[key];
  if (!rec) return;
  rec.lastUsedAt = Date.now();
  scheduleSave();
}
/* ------------------------------------------------------------------ */
/* Storage accounting                                                  */
/* ------------------------------------------------------------------ */

export async function storageStats(): Promise<{
  quota?: number;
  usage?: number;
  persisted: boolean;
}> {
  try {
    const est = await navigator.storage?.estimate?.();
    let persisted = false;
    try {
      persisted = (await navigator.storage?.persisted?.()) ?? false;
    } catch {
      /* ignore */
    }
    return { quota: est?.quota, usage: est?.usage, persisted };
  } catch {
    return { persisted: false };
  }
}

export async function ensurePersisted(): Promise<boolean> {
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Finished bytes plus in-progress partials (bytesDone approximates cache footprint). */
export function usedBytes(records: DownloadRecord[]): number {
  return records.reduce(
    (sum, r) =>
      sum + (r.state === "done" ? r.sizeBytes : Math.max(0, r.bytesDone || 0)),
    0
  );
}

/** Delete every Cache Storage file owned by a record. */
export async function deleteRecordFiles(rec: DownloadRecord): Promise<void> {
  try {
    const c = await caches.open(DL_CACHE);
    await Promise.all(rec.fileUrls.map((u) => c.delete(u).catch(() => false)));
    // Poster thumb is not in fileUrls (it isn't media) — drop it explicitly
    // so deleting the last download doesn't leak a few kilobytes forever.
    const poster = posterThumbUrl(rec.posterPath);
    if (poster) await c.delete(poster).catch(() => false);
  } catch {
    /* cache unavailable — nothing to do */
  }
}

/**
 * True when the finished download's bytes are still in the cache.
 * Checks the playlist plus up to 2 sample segments — playlist-only checks
 * miss OS-evicted segments. The OS may evict origin storage; call on
 * settings-open and before offline play to flip stale `done` rows to
 * `missing`. Exceptions (transient cache failure) stay healthy: never flip
 * on inconclusive evidence.
 */
export async function verifyRecordFiles(key: string): Promise<boolean> {
  const rec = getRecordSync(key) ?? (await load())[key];
  if (!rec || rec.state !== "done") return !!rec;
  try {
    const c = await caches.open(DL_CACHE);
    const hit = await c.match(dlPlaylistUrl(rec.key));
    if (!hit) {
      await upsertRecord({ ...rec, state: "missing" });
      return false;
    }
    // Sample owned segment files (first + middle + last): catches partial
    // eviction without reading the whole set. First+last alone used to
    // vouch for a long episode with a hole in the middle.
    const owned = (rec.fileUrls ?? []).filter((u) => u !== dlPlaylistUrl(rec.key));
    const sampleIdx = new Set<number>([
      0,
      Math.floor(owned.length / 2),
      owned.length - 1,
    ]);
    const samples = [...sampleIdx]
      .filter((i) => i >= 0 && i < owned.length)
      .map((i) => owned[i]!);
    for (const u of samples) {
      const seg = await c.match(u);
      if (!seg) {
        await upsertRecord({ ...rec, state: "missing" });
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}
/* ------------------------------------------------------------------ */
/* Offline resume positions (local only — server sync is a later phase) */
/* ------------------------------------------------------------------ */

/**
 * localStorage mirror of where offline playback stopped, per download key.
 * Shape is shared with public/offline.html (raw localStorage, same key):
 *   { [dlKey]: { pos: number; dur: number; at: number } }
 */
const OFFLINE_POS_LS_KEY = "tvtime-offline-positions";

export type OfflinePosition = { pos: number; dur: number; at: number };

function readPosMap(): Record<string, OfflinePosition> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OFFLINE_POS_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, OfflinePosition>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Broadcast a position change so mounted rows re-read without a remount. */
function emitOfflinePosition(key: string): void {
  window.dispatchEvent(
    new CustomEvent("tvtime:offline-position", { detail: { key } })
  );
}

/**
 * Persist an offline stop position (throttle callers to ~2s).
 * `pos <= 0` is never stored — readOfflinePosition treats it as absent, so a
 * warmup 0 would only clobber the map (the caller already drops that noise).
 */
export function writeOfflinePosition(key: string, pos: number, dur: number): void {
  if (typeof window === "undefined") return;
  if (!key || !Number.isFinite(pos) || pos <= 0) return;
  try {
    const map = readPosMap();
    map[key] = {
      pos,
      dur: Number.isFinite(dur) && dur > 0 ? dur : 0,
      at: Date.now(),
    };
    window.localStorage.setItem(OFFLINE_POS_LS_KEY, JSON.stringify(map));
    emitOfflinePosition(key);
  } catch {
    /* storage unavailable — resume just won't stick */
  }
}

export function readOfflinePosition(key: string): OfflinePosition | null {
  if (!key) return null;
  const entry = readPosMap()[key];
  if (!entry || !Number.isFinite(entry.pos) || entry.pos <= 0) return null;
  return entry;
}

export function clearOfflinePosition(key: string): void {
  if (typeof window === "undefined" || !key) return;
  try {
    const map = readPosMap();
    if (map[key]) {
      delete map[key];
      window.localStorage.setItem(OFFLINE_POS_LS_KEY, JSON.stringify(map));
      emitOfflinePosition(key);
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Server → offline resume sync (streamed progress becomes a Resume line) */
/* ------------------------------------------------------------------ */

export type ServerPositionRow = {
  mediaType: string;
  tmdbId: number;
  seasonNumber?: number;
  episodeNumber?: number;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt?: string;
};

/** Same identity as downloadKey(), so a server row lands on its row's key. */
export function serverPositionKey(row: ServerPositionRow): string {
  const isMovie = row.mediaType === "movie";
  return downloadKey(
    isMovie ? "movie" : "episode",
    row.tmdbId,
    isMovie ? undefined : row.seasonNumber ?? 0,
    isMovie ? undefined : row.episodeNumber ?? 0
  );
}

/**
 * Merge a server bookmark into the local offline one. The offline mirror only
 * ever hears from offline playback, so the higher of the two is the truth:
 *   - server finished (>= 92%) → null: online playback ran to the end, so the
 *     stale local Resume line is dropped (mirrors the online 92% clear).
 *   - no local → the server value, when it is worth resuming.
 *   - both → max, re-gated by the resume rules (a fresh 0-5s server start
 *     never wipes local progress, and non-resumable results never store).
 */
export function mergeOfflinePosition(
  local: OfflinePosition | null,
  serverPos: number,
  serverDur: number
): OfflinePosition | null {
  const sPos = Number.isFinite(serverPos) ? Math.max(0, serverPos) : 0;
  const sDur = Number.isFinite(serverDur) ? Math.max(0, serverDur) : 0;
  if (sDur > 0 && sPos >= sDur * RESUME_END_RATIO) return null;
  if (!local) {
    return isResumablePosition(sPos, sDur) ? { pos: sPos, dur: sDur, at: Date.now() } : null;
  }
  const pos = Math.max(local.pos, sPos);
  const dur = Math.max(local.dur, sDur);
  if (!isResumablePosition(pos, dur)) return null;
  return { pos, dur, at: Math.max(local.at, Date.now()) };
}

/** One bulk read per view — a repeat within this window is a no-op. */
const POS_SYNC_TTL_MS = 60_000;
let lastPosSyncAt = 0;

/**
 * Pull every server bookmark and fold it into the local mirror for the given
 * finished downloads, so /library shows "Resume" for progress made while
 * streaming online. Best effort: offline, signed out, or unreachable all
 * leave the local mirror untouched. Writes emit tvtime:offline-position, so
 * mounted rows update without a remount.
 */
export async function syncOfflinePositions(records: DownloadRecord[]): Promise<void> {
  if (typeof window === "undefined" || !navigator.onLine) return;
  const done = records.filter((r) => r.state === "done");
  if (done.length === 0) return;
  const now = Date.now();
  if (now - lastPosSyncAt < POS_SYNC_TTL_MS) return;
  lastPosSyncAt = now;

  let items: ServerPositionRow[] = [];
  try {
    const res = await fetch("/api/playback?all=1", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const data = (await res.json()) as { items?: unknown };
    if (Array.isArray(data?.items)) items = data.items as ServerPositionRow[];
  } catch {
    return;
  }

  const byKey = new Map<string, ServerPositionRow>();
  for (const row of items) {
    if (row && Number.isFinite(row.tmdbId)) byKey.set(serverPositionKey(row), row);
  }

  for (const record of done) {
    const row = byKey.get(record.key);
    if (!row) continue;
    const local = readOfflinePosition(record.key);
    const merged = mergeOfflinePosition(local, row.positionSeconds, row.durationSeconds);
    if (merged === null) {
      if (local) clearOfflinePosition(record.key);
      continue;
    }
    if (local && local.pos === merged.pos && local.dur === merged.dur) continue;
    writeOfflinePosition(record.key, merged.pos, merged.dur);
  }
}

/* ------------------------------------------------------------------ */
/* Playback-sync outbox (positions + watched marks, replay on reconnect) */
/* ------------------------------------------------------------------ */

export type OutboxEntry = {
  /** Playback key, e.g. "tv:123:1:2" (the /api/playback query). */
  params: string;
  method: string;
  body?: string;
  /**
   * Absolute path to replay. Present on everything written by this build;
   * older persisted entries only have `params` and are rebuilt as
   * `/api/playback?${params}` below.
   */
  url?: string;
  at: number;
  attempts: number;
};

const OUTBOX_IDB_KEY = "tvtime-playback-outbox-v1";
/** Cap the outbox (episodes are tiny; this is many movies of backlog). */
const OUTBOX_MAX = 200;
/** Give up replaying a single entry after this many failed drains. */
const OUTBOX_MAX_ATTEMPTS = 20;

async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    const raw = await get<OutboxEntry[]>(OUTBOX_IDB_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveOutbox(list: OutboxEntry[]): Promise<void> {
  try {
    await set(OUTBOX_IDB_KEY, list.slice(-OUTBOX_MAX));
  } catch {
    /* storage unavailable — sync just won't survive reload */
  }
}

/**
 * Pure coalesce: same params+method replaces (positions), a DELETE absorbs
 * pending POSTs for the same key (finished beats everything before it).
 * Exported for unit tests.
 *
 * Callers that need every entry kept (one `/api/watch` POST per episode all
 * share a URL) must fold the discriminator into `params`.
 */
export function coalesceOutbox(
  list: OutboxEntry[],
  entry: OutboxEntry
): OutboxEntry[] {
  const next = list.filter(
    (e) =>
      !(
        e.params === entry.params &&
        (e.method === entry.method ||
          (entry.method === "DELETE" && e.method !== "DELETE"))
      )
  );
  next.push(entry);
  return next.slice(-OUTBOX_MAX);
}

/**
 * Serialize every outbox read-modify-write. Drain used to save its own
 * (mutated) snapshot wholesale, so anything enqueued mid-drain — e.g. the
 * watched-mark from an episode ending during a reconnect flush — was erased
 * on save; two concurrent enqueues lost the same way.
 */
let outboxChain: Promise<unknown> = Promise.resolve();
function withOutbox<T>(fn: () => Promise<T>): Promise<T> {
  const run = outboxChain.then(fn, fn);
  outboxChain = run.catch(() => undefined);
  return run;
}

export async function enqueuePlayback(entry: Omit<OutboxEntry, "at" | "attempts">): Promise<void> {
  await withOutbox(async () => {
    const list = await loadOutbox();
    await saveOutbox(
      coalesceOutbox(list, { ...entry, at: Date.now(), attempts: 0 })
    );
  });
}

/** Non-replayable statuses: replaying can never heal these. */
export function isPermanentFailure(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

let draining = false;

/**
 * Replay queued saves oldest-first. Independent episodes don't block each
 * other: failures stay queued (attempts++) for the next drain; successes
 * and over-retried/permanent entries leave. Safe to call any time.
 */
export async function drainPlaybackOutbox(): Promise<void> {
  if (draining || typeof window === "undefined") return;
  draining = true;
  try {
    await withOutbox(async () => {
      const list = await loadOutbox();
      if (list.length === 0) return;
      // Offline drains must not burn attempts — opening the app on a plane
      // 20 times used to permanently discard every queued watched-mark.
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      for (const entry of list) {
        if (typeof navigator !== "undefined" && !navigator.onLine) break;
        try {
          const res = await fetch(entry.url ?? `/api/playback?${entry.params}`, {
            method: entry.method,
            headers: { "Content-Type": "application/json" },
            body: entry.body,
            credentials: "same-origin",
          });
          if (res.ok || isPermanentFailure(res.status)) {
            entry.attempts = OUTBOX_MAX_ATTEMPTS + 1; // mark for removal
          } else if (
            res.status >= 400 &&
            res.status < 500 &&
            res.status !== 408 &&
            res.status !== 425 &&
            res.status !== 429
          ) {
            entry.attempts += 1; // client rejection: bounded retries
          }
          // 5xx/429: server-side trouble — retry on the next drain without
          // burning the budget (a flaky night used to discard the mark).
        } catch {
          // Network failure mid-flight: keep the entry untouched.
        }
      }
      await saveOutbox(list.filter((e) => e.attempts < OUTBOX_MAX_ATTEMPTS));
    });
  } finally {
    draining = false;
  }
}

let outboxInit = false;

/**
 * Wire reconnect/startup drains. Idempotent — call once from Providers.
 * No Background Sync dependency: the online event + app start cover every
 * browser (SyncManager is Chromium-only).
 */
export function initPlaybackOutbox(): void {
  if (outboxInit || typeof window === "undefined") return;
  outboxInit = true;
  void drainPlaybackOutbox();
  window.addEventListener("online", () => {
    void drainPlaybackOutbox();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void drainPlaybackOutbox();
  });
}
