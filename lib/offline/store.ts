/**
 * Offline store: download manifest (IndexedDB + sync mirror), Cache Storage
 * accounting, resume positions, and the playback-sync outbox. Single owner
 * of all offline persistence shapes (also read raw by public/offline.html).
 */
import { get, set } from "idb-keyval";
import { dlPlaylistUrl } from "@/lib/offline/hls";

export const DL_CACHE = "tvtime-downloads";
const MANIFEST_IDB_KEY = "tvtime-download-manifest-v1";

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

async function load(): Promise<Record<string, DownloadRecord>> {
  if (cache) return cache;
  try {
    cache = (await get<Record<string, DownloadRecord>>(MANIFEST_IDB_KEY)) ?? {};
  } catch {
    cache = {};
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
  if (typeof window !== "undefined") {
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
    // Sample up to 2 owned segment files (first + last): catches partial
    // eviction without reading the whole set.
    const owned = (rec.fileUrls ?? []).filter((u) => u !== dlPlaylistUrl(rec.key));
    const samples = [
      ...(owned.length > 0 ? [owned[0]!] : []),
      ...(owned.length > 1 ? [owned[owned.length - 1]!] : []),
    ];
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

/** Persist an offline stop position (throttle callers to ~2s). */
export function writeOfflinePosition(key: string, pos: number, dur: number): void {
  if (typeof window === "undefined") return;
  if (!key || !Number.isFinite(pos) || pos < 0) return;
  try {
    const map = readPosMap();
    map[key] = {
      pos,
      dur: Number.isFinite(dur) && dur > 0 ? dur : 0,
      at: Date.now(),
    };
    window.localStorage.setItem(OFFLINE_POS_LS_KEY, JSON.stringify(map));
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
    }
  } catch {
    /* ignore */
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

export async function enqueuePlayback(entry: Omit<OutboxEntry, "at" | "attempts">): Promise<void> {
  const list = await loadOutbox();
  await saveOutbox(
    coalesceOutbox(list, { ...entry, at: Date.now(), attempts: 0 })
  );
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
    const list = await loadOutbox();
    if (list.length === 0) return;
    for (const entry of list) {
      try {
        const res = await fetch(`/api/playback?${entry.params}`, {
          method: entry.method,
          headers: { "Content-Type": "application/json" },
          body: entry.body,
          credentials: "same-origin",
        });
        if (res.ok || isPermanentFailure(res.status)) {
          entry.attempts = OUTBOX_MAX_ATTEMPTS + 1; // mark for removal
        } else {
          entry.attempts += 1;
        }
      } catch {
        entry.attempts += 1;
      }
    }
    await saveOutbox(list.filter((e) => e.attempts < OUTBOX_MAX_ATTEMPTS));
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
