/**
 * Persistent VixSrc native-player settings.
 *
 * Stored in localStorage so audio/subtitle/quality/speed/volume choices
 * survive player remounts (episode-to-episode) and app restarts.
 *
 * Schema is versioned: older builds saved hls.js-internal track switches
 * (e.g. auto-selected Italian subs) as if they were user choices. Bumping the
 * version discards that poisoned state.
 */
import type { StreamSource } from "@/lib/player-native-types";
import { CINESRC_MAX_KNOWN_SERVERS, CINESRC_SEED_SERVERS } from "@/lib/embed-sources";

export type VixSettings = {
  /** Settings schema version — bump to invalidate old stored state. */
  v: number;
  /** Audio track language code, e.g. "en" | "it". */
  audio: string;
  /** Subtitle track language code, or "off". */
  subs: string | "off";
  /** Preferred video height: "auto" or e.g. 1080/720/480. */
  quality: "auto" | number;
  /** Playback rate multiplier. */
  speed: number;
  /** Per-show speed memory: "tv:123" | "movie:456" -> rate. Falls back to speed. */
  speedByShow: Record<string, number>;
  /** 0..1 */
  volume: number;
  /**
   * Session-only mute. Never restored from localStorage/server — autoplay and
   * PWA caches were permanently silencing users (e.g. ola).
   */
  muted: boolean;
  /** Auto-play the next episode when the current one ends (TV only). */
  autoplayNext: boolean;
  /** Force landscape while the player is fullscreen (Netflix-style). */
  autoRotate: boolean;
  /**
   * Subtitle source preference (picker in the player):
   * "auto" (default) = stream CC when present, else VDRK → OpenSubtitles;
   * "off" = never show; "stream" = stream's own English CC only;
   * "vdrk" = force VDRK VTT; "opensub" = force OpenSubtitles VTT.
   */
  subSource: "auto" | "off" | "stream" | "vdrk" | "opensub";
  /** Last stream backend the user picked (native or embed source). */
  preferredSource: StreamSource;
  /**
   * CineSrc sub-server hint ("auto" = CineSrc picks). Sent as
   * `lastserver=<id>&prioritize=true` on the CineSrc embed URL.
   * Case is preserved: ids must match CineSrc's own server ids verbatim.
   */
  cineSrcServer: string;
  /**
   * Real CineSrc server ids discovered via the embed's `cinesrc:sourceused`
   * event (e.g. "Nebula"). Drives the sub-server picker options.
   */
  cineSrcKnownServers: string[];
  /**
   * Subtitle timing offset in seconds (positive = later). Applies to
   * injected VDRK/OpenSubtitles cues; stream-embedded CC is unaffected.
   */
  subDelaySeconds: number;
  /** Cue text size. */
  subFontSize: "xs" | "sm" | "md" | "lg";
  /** Cue text color. */
  subColor: "white" | "yellow" | "cyan";
  /** Cue background opacity 0..1. */
  subBgOpacity: number;
  /** Cue background blur (liquid-glass pill). Off when background is off. */
  subBgBlur: "none" | "sm" | "md" | "lg";
  /** Dialogue boost (WebAudio gain) for quiet mixes. Native mode only. */
  audioBoost: boolean;
  /** Ambilight glow behind native video. Auto-off on reduced motion. */
  ambilight: boolean;
  /** Native aspect mode (object-fit). */
  videoFit: "fit" | "cover" | "stretch";
  /** Iframe zoom (CSS scale crop) — cross-origin frames lack aspect APIs. */
  embedZoom: 1 | 1.25 | 1.5;
  /**
   * Offline-download mode. Off by default; download buttons only render
   * while this is on (profile → Download settings).
   */
  downloadMode: boolean;
  /**
   * Preferred download height for offline copies. "best" takes the top
   * variant the source offers (big files — desktop territory).
   */
  downloadQuality: 480 | 720 | 1080 | "best";
  /** Self-imposed offline storage cap in MiB (default 950). */
  downloadCapMb: number;
};

export const VIX_SETTINGS_KEY = "vix-settings";

/** v3: drop persisted mute (autoplay/PWA poison). */
export const VIX_SETTINGS_VERSION = 3;

export const DEFAULT_VIX_SETTINGS: VixSettings = {
  v: VIX_SETTINGS_VERSION,
  audio: "en",
  subs: "en",
  quality: "auto",
  speed: 1,
  speedByShow: {},
  volume: 1,
  muted: false,
  autoplayNext: true,
  autoRotate: true,
  preferredSource: "vix",
  cineSrcServer: "auto",
  cineSrcKnownServers: [...CINESRC_SEED_SERVERS],
  subSource: "auto",
  subDelaySeconds: 0,
  subFontSize: "md",
  subColor: "white",
  subBgOpacity: 0.35,
  subBgBlur: "md",
  audioBoost: false,
  ambilight: true,
  videoFit: "fit",
  embedZoom: 1,
  downloadMode: false,
  downloadQuality: 720,
  downloadCapMb: 950,
};

/** Language codes that should NEVER apply as a default (hard user rule).
 *  Bidirectional includes() below covers ita/forced-ita variants. */
const BANNED_SUB_LANGS = ["it"];

export function isBannedSubLang(lang: string | undefined | null): boolean {
  const l = (lang || "").toLowerCase().trim();
  if (!l) return false;
  return BANNED_SUB_LANGS.some(
    (b) => l === b || l.includes(b) || b.includes(l)
  );
}

/** Always strip mute — it is session-only. */
function clampSettings(merged: VixSettings): VixSettings {
  const next = { ...merged, v: VIX_SETTINGS_VERSION, muted: false };
  if (isBannedSubLang(next.subs)) next.subs = "en";
  if (isBannedSubLang(next.audio)) next.audio = "en";
  // Per-show speed memory: finite rates in a sane range, capped entries.
  if (next.speedByShow == null || typeof next.speedByShow !== "object") {
    next.speedByShow = {};
  } else {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(next.speedByShow)) {
      if (typeof k === "string" && k.length > 0 && k.length <= 32 && typeof v === "number" && Number.isFinite(v) && v >= 0.25 && v <= 4) {
        clean[k] = v;
      }
      if (Object.keys(clean).length >= 200) break;
    }
    next.speedByShow = clean;
  }
  next.audioBoost = next.audioBoost === true;
  next.ambilight = next.ambilight !== false;
  const SOURCE_VALUES = [
    "vix",
    "goated",
    "vidfast",
    "vidlink",
    "vidnest",
    "cinesrc",
    "2embed",
    "mapple",
    "vidapi",
    "ythd",
    "xpass",
  ] as const;
  if (!(SOURCE_VALUES as readonly string[]).includes(next.preferredSource)) {
    next.preferredSource = "vix";
  }
  // CineSrc sub-server hint: any non-empty id is accepted (it must match one
  // of CineSrc's real server ids verbatim — case preserved, never lowered).
  if (typeof next.cineSrcServer !== "string" || !next.cineSrcServer.trim()) {
    next.cineSrcServer = "auto";
  } else if (next.cineSrcServer !== "auto") {
    next.cineSrcServer = next.cineSrcServer.trim();
  }
  // Discovered server ids: non-empty strings, deduped, order-kept, capped.
  if (!Array.isArray(next.cineSrcKnownServers)) {
    next.cineSrcKnownServers = [...CINESRC_SEED_SERVERS];
  } else {
    const seen = new Set<string>();
    const ids = next.cineSrcKnownServers
      .filter(
        (id): id is string =>
          typeof id === "string" && !!id.trim()
      )
      .map((id) => id.trim());
    for (const id of ids) seen.add(id.toLowerCase());
    // Never lose the seed ids (older installs stored an empty list).
    for (const seed of CINESRC_SEED_SERVERS) {
      if (!seen.has(seed.toLowerCase())) {
        ids.push(seed);
        seen.add(seed.toLowerCase());
      }
    }
    // wave is Hera. Keep that server directly after lisbon (Odysseus),
    // including lists saved before the move.
    const waveAt = ids.findIndex((id) => id.toLowerCase() === "wave");
    const lisbonAt = ids.findIndex((id) => id.toLowerCase() === "lisbon");
    if (waveAt >= 0 && lisbonAt >= 0 && waveAt !== lisbonAt + 1) {
      const [wave] = ids.splice(waveAt, 1);
      const after = ids.findIndex((id) => id.toLowerCase() === "lisbon");
      if (wave) ids.splice(after + 1, 0, wave);
    }
    next.cineSrcKnownServers = ids.slice(0, CINESRC_MAX_KNOWN_SERVERS);
  }
  if (
    typeof next.subDelaySeconds !== "number" ||
    !Number.isFinite(next.subDelaySeconds)
  ) {
    next.subDelaySeconds = 0;
  } else {
    next.subDelaySeconds = Math.max(-10, Math.min(10, next.subDelaySeconds));
  }
  if (
    next.subFontSize !== "xs" &&
    next.subFontSize !== "sm" &&
    next.subFontSize !== "md" &&
    next.subFontSize !== "lg"
  ) {
    next.subFontSize = "md";
  }
  if (
    next.subColor !== "white" &&
    next.subColor !== "yellow" &&
    next.subColor !== "cyan"
  ) {
    next.subColor = "white";
  }
  if (
    typeof next.subBgOpacity !== "number" ||
    !Number.isFinite(next.subBgOpacity)
  ) {
    next.subBgOpacity = 0.35;
  } else {
    next.subBgOpacity = Math.max(0, Math.min(1, next.subBgOpacity));
  }
  if (
    next.subBgBlur !== "none" &&
    next.subBgBlur !== "sm" &&
    next.subBgBlur !== "md" &&
    next.subBgBlur !== "lg"
  ) {
    next.subBgBlur = "md";
  }
  if (
    next.videoFit !== "fit" &&
    next.videoFit !== "cover" &&
    next.videoFit !== "stretch"
  ) {
    next.videoFit = "fit";
  }
  if (
    next.embedZoom !== 1 &&
    next.embedZoom !== 1.25 &&
    next.embedZoom !== 1.5
  ) {
    next.embedZoom = 1;
  }
  if (typeof next.volume !== "number" || !Number.isFinite(next.volume)) {
    next.volume = 1;
  } else {
    next.volume = Math.max(0, Math.min(1, next.volume));
  }
  next.autoplayNext = next.autoplayNext !== false;
  next.autoRotate = next.autoRotate !== false;
  next.downloadMode = next.downloadMode === true;
  if (
    next.downloadQuality !== 480 &&
    next.downloadQuality !== 720 &&
    next.downloadQuality !== 1080 &&
    next.downloadQuality !== "best"
  ) {
    next.downloadQuality = 720;
  }
  if (
    typeof next.downloadCapMb !== "number" ||
    !Number.isFinite(next.downloadCapMb)
  ) {
    next.downloadCapMb = 950;
  } else {
    next.downloadCapMb = Math.max(100, Math.min(32_000, next.downloadCapMb));
  }
  return next;
}

export function loadVixSettings(): VixSettings {
  const base = { ...DEFAULT_VIX_SETTINGS };
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(VIX_SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<VixSettings>;
    // Field-level migrate (not full wipe): clampSettings always strips mute and
    // rewrites v. Older schemas keep speed/subs/quality/source prefs.
    return clampSettings({ ...base, ...parsed });
  } catch {
    /* corrupt or unavailable storage — use defaults */
  }
  return base;
}

export function saveVixSettings(patch: Partial<VixSettings>) {
  if (typeof window === "undefined") return;
  try {
    // muted is intentionally ignored — session-only via the <video> element.
    const safePatch = { ...patch };
    delete safePatch.muted;
    const next = clampSettings({ ...loadVixSettings(), ...safePatch });
    window.localStorage.setItem(VIX_SETTINGS_KEY, JSON.stringify(next));
    // Let live UI (download buttons, settings sheets) react without reload.
    window.dispatchEvent(new CustomEvent("vix-settings-changed"));
    queueServerSync();
  } catch {
    /* storage unavailable — persistence is best-effort */
  }
}

/** Debounce window for server sync (ms). */
const SERVER_SYNC_DELAY = 800;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fire-and-forget server sync of the current settings. Debounced so rapid
 * track/quality changes (multiple saveVixSettings calls per second) coalesce
 * into one POST. Never throws; unauthenticated/offline calls are no-ops.
 * Waits for hydrate so a stale PWA cache cannot overwrite a server unmute.
 */
function queueServerSync() {
  if (typeof window === "undefined") return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const run = () => {
      try {
        void fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: loadVixSettings() }),
        }).catch(() => {
          /* offline / 401 — localStorage still holds the value */
        });
      } catch {
        /* no-op */
      }
    };
    if (hydratePromise) void hydratePromise.finally(run);
    else run();
  }, SERVER_SYNC_DELAY);
}

/**
 * Pull server-side settings once per session and overwrite localStorage so
 * cross-device choices apply immediately. Called from the app Providers on
 * mount. Server is the source of truth across devices; localStorage is the
 * cache. No-op when unauthenticated (per-user data) or already hydrated.
 */
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

export function hydrateVixSettings(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = fetch("/api/settings")
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { settings?: Partial<VixSettings> } | null) => {
      if (!data?.settings) {
        // Still wipe mute from any pre-hydrate local cache.
        try {
          const local = loadVixSettings();
          window.localStorage.setItem(
            VIX_SETTINGS_KEY,
            JSON.stringify(clampSettings(local))
          );
        } catch {
          /* ignore */
        }
        return;
      }
      const merged = clampSettings({
        ...DEFAULT_VIX_SETTINGS,
        ...data.settings,
      });
      try {
        window.localStorage.setItem(VIX_SETTINGS_KEY, JSON.stringify(merged));
      } catch {
        /* storage unavailable — nothing to do */
      }
    })
    .catch(() => {
      /* network/auth failure — keep localStorage as-is but strip mute */
      try {
        window.localStorage.setItem(
          VIX_SETTINGS_KEY,
          JSON.stringify(clampSettings(loadVixSettings()))
        );
      } catch {
        /* ignore */
      }
    })
    .finally(() => {
      hydrated = true;
    });
  return hydratePromise;
}

/** Loose language matcher: "en" matches "eng", "it" matches "ita"/"forced-ita". */
export function matchLang(lang: string | undefined, want: string): boolean {
  const l = (lang || "").toLowerCase().trim();
  const w = (want || "").toLowerCase().trim();
  // Empty codes must not match everything (`"en".includes("") === true`).
  if (!l || !w) return false;
  return l === w || l.includes(w) || w.includes(l);
}
