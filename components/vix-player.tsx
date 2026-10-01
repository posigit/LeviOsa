"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SkipForward, Captions } from "lucide-react";
import {
  isVixEmbedBlockedHost,
  parseVixPlayerEventData,
} from "@/lib/vixsrc";
import {
  EMPTY_SEGMENTS,
  fetchSegments,
  type IntroDbSegment,
  type IntroDbSegments,
} from "@/lib/introdb";
import {
  clearOfflinePosition,
  writeOfflinePosition,
} from "@/lib/downloads";
import {
  EMBED_SOURCES,
  CINESRC_MAX_KNOWN_SERVERS,
  buildCineSrcServerOptions,
  embedUrlFor,
  isEmbedPlayerOrigin,
  sendCineSrcCommand,
  sendVidfastCommand,
  sourceLabel,
  withCineSrcQuality,
  withCineSrcServer,
  warnOnceRejectedPlayerEvent,
} from "@/lib/embed-sources";
import { EmbedHint } from "@/components/embed-hint";
import { PlayerErrorOverlay } from "@/components/player-error-overlay";
import {
  BufferingSpinner,
  LoadingPill,
  TapCue,
  UnlockButton,
} from "@/components/player-overlays";
import { ResumeOverlay } from "@/components/resume-overlay";
import { DownloadButton } from "@/components/download-button";
import {
  IframeSubtitleOverlay,
  SubtitleOverlay,
} from "@/components/subtitle-overlay";
import { PlayerTransport } from "@/components/player-transport";
import { PlayerTopChrome } from "@/components/player-top-chrome";
import {
  loadVixSettings,
  saveVixSettings,
  type VixSettings,
} from "@/lib/vix-settings";
import {
  NEXT_FAB_RATIO,
  RESUME_MIN_SECONDS,
} from "@/lib/player-constants";
  import {
    addStartAt,
    isFinishedPosition,
    isNearEndPosition,
    isPreSeekNoise,
    isResumablePosition,
    makePlaybackKey,
    shouldFireEnded,
  } from "@/lib/player-progress";
import {
  createClearPosition,
  createSavePosition,
  waitForPlaybackRequests,
} from "@/lib/player-progress-save";
import {
  SUB_COLORS,
  SUB_FONT_SCALE,
  cueTextAt,
  fetchExternalVtt,
  injectVttTrack,
  listOpenSubtitles,
  listSubDl,
  parseVttCues,
  type OpenSubListItem,
  type SubFileId,
  type SubSource,
  type VttCue,
} from "@/lib/player-subs";
import { attachNativePlayback } from "@/lib/player-engine";
import { useCastRemote } from "@/lib/player-cast";
import { resolveStreamPlaylist } from "@/lib/player-stream";
import { seekVideoElement } from "@/lib/player-seek";
import type {
  AudioTrackInfo,
  QualityLevelInfo,
  StreamSource,
} from "@/lib/player-native-types";
import { destroyAudioGraph } from "@/lib/player-audio-graph";
import { streamErrorCopy, type StreamErrorInfo } from "@/lib/player-error-copy";
import {
  ALL_SOURCES,
  disabledSourcesFor,
  nextPlayableSource,
} from "@/lib/player-source-picker";
import {
  beginLockMount,
  endLockMount,
  readSessionLocked,
  writeSessionLocked,
} from "@/lib/player-session-lock";

/**
 * Full-screen VixSrc player overlay.
 *
 * Primary path: resolves the stream through /api/vixsrc/stream and plays the
 * HLS master playlist natively with hls.js — no iframe, so Cloudflare's
 * iframe challenge and *.vercel.app referer block never apply.
 *
 * Fallback: if the stream route fails (or native playback errors), falls back
 * to the signed iframe embed (src) and forwards its postMessage events.
 *
 * Events (both paths): play / pause / seeked / ended / timeupdate.
 */

/** Position payload attached to player events (seeked / ended / near-end). */
type PlayerEventPos = { t?: number; duration?: number };

export function VixPlayer({
  src,
  title,
  onEvent,
  onClose,
  onNearEnd,
  type,
  tmdbId,
  season,
  episode,
  autoResume = false,
  source = "vix",
  initialPosition = null,
  initialPlaylistUrl = null,
  initialSubVtt = null,
  initialSubAlts = null,
  offlineKey = null,
  initialSegments = null,
  initialDuration = null,
  overlaySlot = null,
}: {
  src: string;
  title: string;
  onEvent?: (event: string, detail?: PlayerEventPos) => void;
  onClose: () => void;
  /** Fires once when playback reaches ~96% (sticky Next FAB gate). */
  onNearEnd?: (pos?: PlayerEventPos) => void;
  type?: "movie" | "tv";
  tmdbId?: number;
  season?: number;
  episode?: number;
  /** Position supplied by a Continue Watching/detail CTA. */
  initialPosition?: number | null;
  /** Seek directly to initialPosition instead of showing the prompt. */
  autoResume?: boolean;
  /** Stream backend: "vix" (default) or "goated". */
  source?: "vix" | "goated";
  /**
   * Offline playback: a cached `/api/dl?playlist=` URL served by the service
   * worker. Skips stream resolution and forces native mode.
   */
  initialPlaylistUrl?: string | null;
  /** Download key for offline resume positions (local only). */
  offlineKey?: string | null;
  /** Segments captured with the download — preferred over fetching. */
  initialSegments?: IntroDbSegments | null;
  /** Stored subtitle for offline playback (injected, never fetched). */
  initialSubVtt?: { vtt: string; label: string } | null;
  /** Stored spare subtitle files (best-first) for offline switching. */
  initialSubAlts?: { vtt: string; label: string }[] | null;
  /**
   * Known total duration (offline downloads know it up front). Fallback for
   * the scrub bar and seek math while hls.js hasn't set one yet — otherwise
   * a non-finite duration silently no-ops every seek.
   */
  initialDuration?: number | null;
  /**
   * Overlays rendered INSIDE the player shell (Up Next card, Next FAB,
   * end-of-line card). The shell is the fullscreen element — anything
   * outside it vanishes in fullscreen, so parents must pass overlays here.
   */
  overlaySlot?: ReactNode;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Fullscreen this shell (not <video>) so SubtitleOverlay + chrome stay visible. */
  const shellRef = useRef<HTMLDivElement>(null);
  const imdbIdRef = useRef<string | null>(null);
  const lastSavedPosRef = useRef(0);
  const lastSavedAtRef = useRef(0);
  /** Throttle for offline position mirror writes (savePosition ticks often). */
  const offlinePosAtRef = useRef(0);
  /** One-shot guard for the offline auto-resume seek below. */
  const offlineResumeDoneRef = useRef(false);
  const onEventRef = useRef(onEvent);
  const onCloseRef = useRef(onClose);
  const onNearEndRef = useRef(onNearEnd);
  const endedRef = useRef(false);
  const nearEndFiredRef = useRef(false);
  const lastTimeRef = useRef(0);
  const remotePositionRef = useRef(0);
  const remoteDurationRef = useRef(0);
  const iframePausedRef = useRef(true);
  const iframeMutedRef = useRef(false);
  /** Parsed VDRK cues rendered over the CineSrc iframe (no <video> track). */
  const [iframeCues, setIframeCues] = useState<VttCue[]>([]);
  /** Resume override for CineSrc quality switches (reload keeps position). */
  const [cineSrcT, setCineSrcT] = useState<number | null>(null);
  const bookmarkClearedRef = useRef(false);
  /** Blocks progress writes until resume check (and optional prompt) finishes. */
  const saveEnabledRef = useRef(false);
  /** While true, keep the video paused under the resume overlay. */
  const holdForResumeRef = useRef(false);
  /**
   * Key of the episode the resume lookup has already run for. The lookup is a
   * per-episode fact — running it again on mode flips (source switches flip
   * native→loading→native) re-arms the hold and re-pops the overlay mid-play.
   */
  const resumeLookupDoneRef = useRef<string | null>(null);
  const resumePosRef = useRef(0);
  /**
   * Pending seek for source-switch OR cold resume. Engine applies after HLS
   * is ready (startPosition + MANIFEST/FRAG) — required for Vix resolver.
   */
  const pendingSeekPosRef = useRef<number | null>(null);
  const pendingSeekWaitersRef = useRef<
    Array<(ok: boolean) => void>
  >([]);
  /** Known total duration (offline) — kept fresh for seek/transport fallbacks. */
  const initialDurationRef = useRef(initialDuration);

  const streamable = type === "movie" || type === "tv";
  // Source backend — prefer last user choice, then prop default.
  // Movie-only embeds (empty tvUrl) fall back to vix so the picker label
  // matches what the iframe actually loads.
  const [activeSource, setActiveSource] = useState<StreamSource>(() => {
    const preferred = loadVixSettings().preferredSource || source;
    if (
      type &&
      tmdbId &&
      EMBED_SOURCES.some((s) => s.key === preferred) &&
      !embedUrlFor(preferred, type, tmdbId, season, episode)
    ) {
      return source;
    }
    return preferred;
  });
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  /**
   * Episode advance (same mount) must autoplay like a fresh open: the resume
   * lookup can finish play() before HLS attaches the new stream, leaving the
   * video parked on frame one. Armed on episode/source/ retry transitions
   * (see src-change effect, switchSource, retryStream); consumed on first
   * readiness (canplay path below). hasResolvedRef distinguishes first mount
   * (autoPlay attribute owns it) from later transitions.
   */
  const advanceNeedsPlayRef = useRef(false);
  const hasResolvedRef = useRef(false);
  // Structured resolve failure (code/detail) for the error card. Cleared on
  // every fresh attempt (mount, source switch, retry).
  const [streamError, setStreamError] = useState<StreamErrorInfo>(null);
  /** Bumped by the error-card Retry button to re-run resolution. */
  const [retryNonce, setRetryNonce] = useState(0);
  /**
   * VidSrc.sh answers with several signed mirror playlists for one title
   * (offline downloads already rotate them). The player pinned the first, so
   * one dead mirror wedged the title on the error card — Retry re-resolved
   * the same list and picked the same URL forever. Retry now steps through
   * the chain; sources without mirrors return a 1-entry chain (no behavior
   * change for Vix/Goated).
   */
  const [mirrorStep, setMirrorStep] = useState(0);
  /** Rebuffer spinner (native waiting/stalled/seek stalls after load). */
  const [buffering, setBuffering] = useState(false);
  // Non-streamable mounts (no type/tmdbId) go straight to iframe fallback.
  const [streamFailed, setStreamFailed] = useState(() => !streamable);
  const [iframeError, setIframeError] = useState(false);
  // Do not seed from RSC props — a dismissed Continue Watching delete must
  // win over a stale show-page bookmark. Lookup always re-reads /api/playback.
  const [resumePosition, setResumePosition] = useState<number | null>(null);
  const [resumeKey, setResumeKey] = useState<string | null>(null);
  const [locked, setLocked] = useState(readSessionLocked);
  /** Persist lock across episode-advance remounts (same session only). */
  const setLockedPersisted = useCallback((next: boolean) => {
    writeSessionLocked(next);
    setLocked(next);
  }, []);
  /** Custom chrome only — native <video controls> are off (dual-layer fix). */
  const [chromeVisible, setChromeVisible] = useState(true);
  /** True once the media element can actually play (not just playlist resolved). */
  const [mediaReady, setMediaReady] = useState(false);
  /** True while a resume seek is in flight (hide transport so we don't flash 0:00). */
  const [resumeSeeking, setResumeSeeking] = useState(false);
  const [transport, setTransport] = useState({
    currentTime: 0,
    duration: 0,
    paused: true,
    muted: false,
    volume: 1,
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
    const chromeHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** True while the pointer rests on the shell — hovering counts as active
     *  use, so the auto-hide timer never fires (leave re-arms it normally). */
    const pointerInsideRef = useRef(false);
  /** Blocks synthetic mouse click after touch chrome toggle. */
  const lastTouchChromeRef = useRef(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(
    () => loadVixSettings().speed
  );
  /** Vix seek-preview thumbnails (VTT URL). Set on resolve, cleared per attempt. */
  const [thumbnailsUrl, setThumbnailsUrl] = useState<string | null>(null);
  /** Per-show speed key ("tv:123" / "movie:456"). */
  const showSpeedKey =
    type != null && tmdbId != null ? `${type}:${tmdbId}` : null;
  /** Sleep timer end (ms epoch) or null. Session-only, never persisted. */
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stop after this episode (autoplay off once). Session-only. */
  const [sleepAfterEpisode, setSleepAfterEpisode] = useState(false);
  /** Dialogue boost (WebAudio gain). Persisted; native mode only. */
  const [audioBoost, setAudioBoost] = useState(
    () => loadVixSettings().audioBoost === true
  );
  const audioGraphRef = useRef<{
    ctx: AudioContext;
    gain: GainNode;
  } | null>(null);
  /** Screen brightness (gesture). 1 = full. Session-only, native mode. */
  const [brightness, setBrightness] = useState(1);
  /** Transient gesture hint bubble. */
  const [gestureHint, setGestureHint] = useState<string | null>(null);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    startVol: number;
    startTime: number;
    active: "seek" | "brightness" | "volume" | null;
  } | null>(null);
  const gestureHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Suppress tap-chrome toggle right after a swipe gesture. */
  const gestureSuppressUntil = useRef(0);
  /** Ambilight glow (persisted). Auto-off on reduced motion. */
  const [ambilight, setAmbilight] = useState(
    () => loadVixSettings().ambilight !== false
  );
  const ambilightCanvasRef = useRef<HTMLCanvasElement>(null);
  const [videoFit, setVideoFit] = useState<VixSettings["videoFit"]>(
    () => loadVixSettings().videoFit
  );
  const [embedZoom, setEmbedZoom] = useState<VixSettings["embedZoom"]>(
    () => loadVixSettings().embedZoom
  );
  const [autoplayNext, setAutoplayNext] = useState(
    () => loadVixSettings().autoplayNext
  );
  // No UI toggle (user request): orientation follows the saved preference.
  const [autoRotate] = useState(
    () => loadVixSettings().autoRotate
  );
  const [subDelay, setSubDelay] = useState(
    () => loadVixSettings().subDelaySeconds
  );
  const [subFontSize, setSubFontSize] = useState<VixSettings["subFontSize"]>(
    () => loadVixSettings().subFontSize
  );
  const [subColor, setSubColor] = useState<VixSettings["subColor"]>(
    () => loadVixSettings().subColor
  );
  const [subBgOpacity, setSubBgOpacity] = useState(
    () => loadVixSettings().subBgOpacity
  );
  const [subBgBlur, setSubBgBlur] = useState<VixSettings["subBgBlur"]>(
    () => loadVixSettings().subBgBlur
  );
  /** True once an external VTT is loaded — Sync can re-time it. */
  const [hasExternalSubs, setHasExternalSubs] = useState(false);
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [audioTrackId, setAudioTrackId] = useState<number>(-1);
  const setHlsAudioTrackRef = useRef<((id: number) => void) | null>(null);
  const [qualityLevels, setQualityLevels] = useState<QualityLevelInfo[]>([]);
  const [qualitySelection, setQualitySelection] = useState<"auto" | number>(
    () => loadVixSettings().quality
  );
  /** CineSrc sub-server hint (Auto = CineSrc picks). Persisted in settings. */
  const [cineSrcServer, setCineSrcServer] = useState<string>(
    () => loadVixSettings().cineSrcServer || "auto"
  );
  /**
   * Real CineSrc server ids discovered via `cinesrc:sourceused` (e.g. Nebula).
   * Persisted so the picker survives restarts; appended in first-seen order.
   */
  const [cineSrcKnownServers, setCineSrcKnownServers] = useState<string[]>(
    () => loadVixSettings().cineSrcKnownServers ?? []
  );
  const knownServersRef = useRef(cineSrcKnownServers);
  useEffect(() => {
    knownServersRef.current = cineSrcKnownServers;
  }, [cineSrcKnownServers]);
  /** Server id the embed reports it is actually using (sourceused event). */
  const [liveCineSrcServer, setLiveCineSrcServer] = useState<string | null>(null);
  const setHlsQualityRef = useRef<((next: "auto" | number) => void) | null>(
    null
  );
  /** Effective rendition reporter (ABR transparency) — engine writes, pill reads. */
  const setEffectiveQualityRef = useRef<((h: number | null) => void) | null>(
    null
  );
  /** Current ABR rendition height (null = unknown). Never persisted. */
  const [effectiveQuality, setEffectiveQuality] = useState<number | null>(null);
  const [subSource, setSubSource] = useState<SubSource>(() => {
    const s = loadVixSettings();
    // Repair bootstrap poison: Auto/stream/external must not keep subs:"off".
    if (s.subSource !== "off" && s.subs === "off") {
      saveVixSettings({ subs: "en" });
    }
    return s.subSource;
  });
  /** Latest subSource for async closures inside the native-playback effect. */
  const subSourceRef = useRef(subSource);
  useEffect(() => {
    subSourceRef.current = subSource;
  }, [subSource]);
  /** Externally injected VTT tracks (VDRK / OpenSubtitles) so we can hide them. */
  const injectedTracksRef = useRef<TextTrack[]>([]);
  /** Offline playback: the <video> the stored VTT was injected into. */
  const offlineSubInjectedRef = useRef<HTMLVideoElement | null>(null);
  /** Last fetched external VTT — re-used when adjusting sync delay (no re-fetch). */
  const externalVttRef = useRef<{ vtt: string; label: string } | null>(null);
  /** Set by the native effect; lets the picker re-run subtitle loading. */
  const reloadSubsRef = useRef<(() => void) | null>(null);
  /** Re-inject cached VTT with current delay only. */
  const reapplyExternalSubsRef = useRef<(() => void) | null>(null);
  /** Safari forced-source delayed load handle (cleared on unmount). */
  // window.setTimeout returns number (DOM); bare setTimeout returns Timeout
  // (Node). We call window.setTimeout, so the ref is number.
  const safariTimerRef = useRef<number | null>(null);
  const [tapCue, setTapCue] = useState<{ side: "left" | "right" } | null>(
    null
  );
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  /** Bottom sub-server menu (transport) — keeps chrome awake like top menus. */
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  /** Mobile More sheet (top chrome) — same keep-awake contract. */
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  /** Mirrored up from PlayerTopChrome (its state is local): the auto-hide
   *  timer must treat the Source menu like every other open menu. */
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  /** Surface external-subtitle fetch failures instead of stranding the picker. */
  const [subError, setSubError] = useState<string | null>(null);
  /** Top subtitle files (max 3, OpenSubs/SubDL) for the CC picker. */
  const [openSubItems, setOpenSubItems] = useState<OpenSubListItem[]>([]);
  const [openSubFileId, setOpenSubFileId] = useState<SubFileId | null>(null);
  /** Stored-file picker override (best-first; null = injected default active). */
  const [savedSubAltPick, setSavedSubAltPick] = useState<number | null>(null);
  /** Active stored-file index: explicit pick wins, else the injected default. */
  const savedSubAltIndex =
    savedSubAltPick ?? (initialSubVtt && initialSubAlts?.length ? 0 : null);
  const [openSubListLoading, setOpenSubListLoading] = useState(false);
  const openSubListKeyRef = useRef<string | null>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const audioMenuRef = useRef<HTMLDivElement>(null);
  const qualityMenuRef = useRef<HTMLDivElement>(null);
  // ProfileMenu-style outside dismiss for CC + audio + quality menus.
  useEffect(() => {
    if (!subMenuOpen && !audioMenuOpen && !qualityMenuOpen) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const node = e.target as Node | null;
      if (subMenuOpen && subMenuRef.current && node && !subMenuRef.current.contains(node)) {
        setSubMenuOpen(false);
      }
      if (audioMenuOpen && audioMenuRef.current && node && !audioMenuRef.current.contains(node)) {
        setAudioMenuOpen(false);
      }
      if (qualityMenuOpen && qualityMenuRef.current && node && !qualityMenuRef.current.contains(node)) {
        setQualityMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSubMenuOpen(false);
        setAudioMenuOpen(false);
        setQualityMenuOpen(false);
      }
    };
    const onScroll = () => {
      setSubMenuOpen(false);
      setAudioMenuOpen(false);
      setQualityMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll);
    };
  }, [subMenuOpen, audioMenuOpen, qualityMenuOpen]);
  const lastTapRef = useRef<{ time: number; side: "left" | "right" } | null>(
    null
  );
  const tapCueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Deferred single-tap chrome toggle (cancelled by double-tap / unmount). */
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Latest gesture volume, persisted once on touch end (not per move). */
  const gestureDirtyVolume = useRef<number | null>(null);
  /** Show-speed already applied for a show key (guards the memory effect). */
  const appliedShowSpeedRef = useRef<string | null>(null);
  /** Last lockscreen position push (throttles MediaSession IPC). */
  const lastPosStateRef = useRef<{ at: number; dur: number }>({ at: 0, dur: -1 });
  /** True once the iPhone video fullscreen hooks are attached. */
  const webkitFsHooked = useRef(false);

  // Embed sources have no native resolver — always play as iframe.
  // (Registered embed keys count even when they have no URL for this media
  // shape — e.g. movie-only embeds on a TV show — so we fall back to the
  // vixsrc iframe instead of running the native goated cascade.)
  // Offline override: a cached playlist skips resolution AND embed mode —
  // bytes are already on-device, so native playback is always correct.
  const offlineOverride = initialPlaylistUrl != null;
  const isEmbedActive =
    !offlineOverride && EMBED_SOURCES.some((s) => s.key === activeSource);
  /**
   * The vixsrc embed (the fallback frame for every native source) can never
   * render from a host vixsrc's WAF blocks — *.vercel.app & friends get a 403
   * block page for any Referer, while the player refuses an empty one. From
   * there, skip the frame and land on the error card (Retry + source switch
   * still work, native playback through the resolver is untouched).
   */
  const vixIframeBlocked =
    !isEmbedActive &&
    typeof window !== "undefined" &&
    isVixEmbedBlockedHost(window.location.hostname);
  // mode: native -> iframe -> error.
  // Offline has no iframe fallback (there is no embed to fall back to, and
  // the cached playlist would render as garbage in a frame) — a dead native
  // stream goes straight to error with download-specific copy below.
  const mode = isEmbedActive
    ? iframeError
      ? "error"
      : "iframe"
    : offlineOverride && streamFailed
      ? "error"
      : streamFailed
        ? iframeError || vixIframeBlocked
          ? "error"
          : "iframe"
        : playlistUrl
            ? "native"
            : "loading";

  useEffect(() => {
      onEventRef.current = onEvent;
    }, [onEvent]);

  useEffect(() => {
    initialDurationRef.current = initialDuration;
  }, [initialDuration]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    onNearEndRef.current = onNearEnd;
  }, [onNearEnd]);

  // ---------- IntroDB segments (skip intro/recap, outro → Up Next) ----------
  // State lives here (above the [src] reset effect); the fetch effect sits
  // further down next to ensureIframeImdb, which it depends on. Stored
  // segments seed state directly (offline-first, no effect setState).
  const [segments, setSegments] = useState<IntroDbSegments>(
    () => initialSegments ?? EMPTY_SEGMENTS
  );
  const segmentsRef = useRef(segments);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  const segmentsKeyRef = useRef<string | null>(null);

  useEffect(() => {
    endedRef.current = false;
    lastTimeRef.current = 0;
    lastSavedPosRef.current = 0;
    lastSavedAtRef.current = 0;
    remotePositionRef.current = 0;
    remoteDurationRef.current = 0;
    iframePausedRef.current = true;
    bookmarkClearedRef.current = false;
    lastTapRef.current = null;
    gestureDirtyVolume.current = null;
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
    setMediaReady(false);
    setIframeCues([]);
    setOpenSubFileId(null);
    setOpenSubItems([]);
    openSubListKeyRef.current = null;
    setCineSrcT(null);
    setServerMenuOpen(false);
    setMoreMenuOpen(false);
    setSourceMenuOpen(false);
    segmentsKeyRef.current = null;
    // Stored segments come back with the reset — the download captured them
    // offline, and wiping them here would cost skip intro / the outro marker.
    setSegments(initialSegments ?? EMPTY_SEGMENTS);
    setStreamError(null);
    setBuffering(false);
    // Stale rendition belongs to the old episode (pill shows Auto · 720p).
    setEffectiveQuality(null);
    // Episode advance (same mount — the shell, and therefore fullscreen,
    // survives): drop the old stream so the previous episode never lingers
    // behind the fresh resolution. First mount is already null — harmless.
    // Arm advance autoplay when leaving a live playlist (first mount has
    // nothing resolved yet, so the autoPlay attribute owns that path).
    if (hasResolvedRef.current) advanceNeedsPlayRef.current = true;
    setPlaylistUrl(null);
    setThumbnailsUrl(null);
    setMirrorStep(0);
    setStreamFailed(false);
    setIframeError(false);
    // Fresh title/episode: drop transient gesture state (no strand-over).
    setBrightness(1);
    setTapCue(null);
    if (tapCueTimerRef.current) {
      clearTimeout(tapCueTimerRef.current);
      tapCueTimerRef.current = null;
    }
  }, [src, initialSegments]);

  // Single mount lifecycle: lock handoff across episode-advance remounts +
  // full teardown on real unmount (timers, audio graph). The lock
  // clear is deferred one macrotask so a synchronous advance-remount can
  // cancel it; a genuine unmount (navigate away) lets it fire.
  useEffect(() => {
    beginLockMount();
    return () => {
      if (chromeHideTimerRef.current) {
        clearTimeout(chromeHideTimerRef.current);
        chromeHideTimerRef.current = null;
      }
      if (tapCueTimerRef.current) {
        clearTimeout(tapCueTimerRef.current);
        tapCueTimerRef.current = null;
      }
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      if (gestureHintTimer.current) {
        clearTimeout(gestureHintTimer.current);
        gestureHintTimer.current = null;
      }
      if (sleepTimerRef.current) {
        clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = null;
      }
      if (safariTimerRef.current) {
        window.clearTimeout(safariTimerRef.current);
        safariTimerRef.current = null;
      }
      destroyAudioGraph(audioGraphRef);
      endLockMount();
    };
  }, []);

  const emit = useCallback((event: string, detail?: PlayerEventPos) => {
    if (event === "ended") {
      if (endedRef.current) return;
      endedRef.current = true;
    }
    onEventRef.current?.(event, detail);
  }, []);

  // ---------- resume playback ----------

  // Build from props (not a post-stream ref) so progress saves still work if
  // the stream route fails and we fall back to the iframe.
  const playbackParams = useCallback(() => {
    return makePlaybackKey(type, tmdbId, season, episode);
  }, [type, tmdbId, season, episode]);

  const savePosition = useCallback(
    (pos: number, duration: number, force = false) => {
      // Pending engine seek / resume floor: drop 0—5s warmup reports only.
      // A backward scrub (43:00 → 3:00) is the new bookmark — keep it.
      if (isPreSeekNoise(pos, pendingSeekPosRef.current)) return;
      if (isPreSeekNoise(pos, resumePosRef.current)) return;
      // Offline: mirror to the local position store (server saves below
      // fail without connection). Throttled — timeupdate ticks constantly.
      // Mirror the shared clear rules too: the final ticks after "ended"
      // (and the 92%-finished zone) used to re-write the mirror right after
      // clearPosition deleted it, leaving a resume-at-credits bookmark.
      if (offlineOverride && offlineKey) {
        const now = Date.now();
        if (force || now - offlinePosAtRef.current > 2000) {
          offlinePosAtRef.current = now;
          if (
            endedRef.current ||
            bookmarkClearedRef.current ||
            isFinishedPosition(pos, duration)
          ) {
            clearOfflinePosition(offlineKey);
          } else {
            writeOfflinePosition(offlineKey, pos, duration);
          }
        }
      }
      // Delegate to shared save rules (throttle, 92% clear, ordered queue).
      const run = createSavePosition(playbackParams, {
        saveEnabledRef,
        endedRef,
        bookmarkClearedRef,
        lastSavedPosRef,
        lastSavedAtRef,
      });
      run(pos, duration, force);
    },
    [playbackParams, offlineOverride, offlineKey]
  );

  const clearPosition = useCallback(() => {
    // Offline finish: drop the local bookmark with the server one.
    if (offlineOverride && offlineKey) clearOfflinePosition(offlineKey);
    const run = createClearPosition(playbackParams, {
      saveEnabledRef,
      endedRef,
      bookmarkClearedRef,
      lastSavedPosRef,
      lastSavedAtRef,
    });
    run();
  }, [playbackParams, offlineOverride, offlineKey]);

  const seekVideo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return Promise.resolve(false);
    // Shared robust seek (HLS often needs retries before currentTime sticks).
    return seekVideoElement(v, t, { play: true });
  }, []);

  /**
   * A manual seek owns the timeline: drop the resume/source-switch pending
   * target so the engine's restore loop (re-armed on every FRAG_LOADED —
   * instant when fragments come from the service worker) can't snap the
   * scrub back to the bookmark, and release anyone waiting on it.
   */
  const dropPendingSeek = useCallback(() => {
    if (pendingSeekPosRef.current == null) return;
    pendingSeekPosRef.current = null;
    resumePosRef.current = 0;
    const waiters = pendingSeekWaitersRef.current;
    pendingSeekWaitersRef.current = [];
    for (const w of waiters) w(true);
  }, []);

  /**
   * Queue a resume/switch seek for the engine (post-manifest / startPosition).
   * Do NOT currentTime-spam before Vix resolver HLS is ready — that is why
   * cold-start Vix always opened at 0 while Goated and mid-session switch worked.
   */
  const seekAndArmSaves = useCallback(
    async (pos: number) => {
      if (!(pos > RESUME_MIN_SECONDS)) {
        holdForResumeRef.current = false;
        saveEnabledRef.current = true;
        setResumeSeeking(false);
        pendingSeekPosRef.current = null;
        return;
      }
      setResumeSeeking(true);
      resumePosRef.current = pos;
      holdForResumeRef.current = true;
      saveEnabledRef.current = false;
      bookmarkClearedRef.current = false;
      lastSavedPosRef.current = pos;
      lastSavedAtRef.current = Date.now();
      pendingSeekPosRef.current = pos;

      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        let poll = 0;
        const finish = (result: boolean) => {
          if (settled) return;
          settled = true;
          window.clearInterval(poll);
          resolve(result);
        };
        pendingSeekWaitersRef.current.push(finish);
        const started = Date.now();
        poll = window.setInterval(() => {
          const v = videoRef.current;
          if (
            v &&
            Number.isFinite(v.currentTime) &&
            Math.abs(v.currentTime - pos) <= 2.5
          ) {
            if (pendingSeekPosRef.current === pos) {
              pendingSeekPosRef.current = null;
            }
            finish(true);
            return;
          }
          if (Date.now() - started > 16_000) {
            finish(false);
          }
        }, 250);
      });

      // Drain any leftover waiters.
      pendingSeekWaitersRef.current = [];
      holdForResumeRef.current = false;
      saveEnabledRef.current = true;
      setResumeSeeking(false);
      if (ok) {
        const v = videoRef.current;
        const t = v && Number.isFinite(v.currentTime) ? v.currentTime : pos;
        savePosition(t, v?.duration ?? 0, true);
        window.setTimeout(() => {
          if (resumePosRef.current === pos) resumePosRef.current = 0;
        }, 4000);
      } else {
        // Seek never landed. Drop the pending target so a later manual
        // scrub / close flush can still save. Keep resumePos briefly as a
        // 0s-noise floor only.
        if (pendingSeekPosRef.current === pos) pendingSeekPosRef.current = null;
        console.warn(
          "[player] resume seek did not land near",
          pos,
          "— protecting bookmark from 0s saves"
        );
        window.setTimeout(() => {
          if (resumePosRef.current === pos) resumePosRef.current = 0;
        }, 30_000);
      }
    },
    [savePosition]
  );

  const onPendingSeekSettled = useCallback(
    (result: { pos: number; ok: boolean }) => {
      const waiters = pendingSeekWaitersRef.current;
      pendingSeekWaitersRef.current = [];
      for (const w of waiters) w(result.ok);
      if (result.ok) {
        const v = videoRef.current;
        if (v && Number.isFinite(v.currentTime) && v.currentTime > 0) {
          // Ensure play after engine seek (hold may have paused).
          void v.play().catch(() => {});
        }
      }
    },
    []
  );

  /** Clamp a target time to the driven embed's known duration. */
  const clampEmbedTime = (target: number): number => {
    const dur = remoteDurationRef.current;
    return dur > 0 ? Math.max(0, Math.min(target, dur)) : Math.max(0, target);
  };

  /** Play/pause the active driven embed (CineSrc and VidFast channels). */
  const sendDrivenPlay = useCallback(
    (play: boolean) => {
      if (activeSource === "vidfast") {
        sendVidfastCommand(iframeRef.current, play ? "play" : "pause");
        // VidFast commands have no ack — re-pull ground truth so a dropped
        // command can't leave our chrome lying about play state.
        window.setTimeout(() => sendVidfastCommand(iframeRef.current, "getStatus"), 350);
      } else {
        sendCineSrcCommand(iframeRef.current, play ? "play" : "pause");
      }
      iframePausedRef.current = !play;
    },
    [activeSource]
  );

  /** Seek the active driven embed (CineSrc and VidFast command channels). */
  const sendEmbedSeek = useCallback(
    (target: number) => {
      if (activeSource === "cinesrc") {
        sendCineSrcCommand(iframeRef.current, "seek", [target]);
      } else if (activeSource === "vidfast") {
        sendVidfastCommand(iframeRef.current, "seek", { time: target });
      }
    },
    [activeSource]
  );

  // CineSrc (controls=false) and VidFast (title/next overlays off) hide their
  // chrome, so ours must replace them. Mapple stays fully interactive — it
  // has no command channel, so layering our transport over it would brick it.
  /** True for iframe embeds we drive (transport + tap-catcher + lock). */
  const isDrivenEmbed =
    mode === "iframe" && (activeSource === "cinesrc" || activeSource === "vidfast");
  const vidfastEmbed = mode === "iframe" && activeSource === "vidfast";
  // Subs only need a clock: driven embeds (transport) + read-only
  // timeupdate clocks (Mapple/VidLink/VidNest/2Embed post PLAYER_EVENT like
  // the others — same assumption Mapple already ships with; VidStuck +
  // Vidy post the same tick via VIDEO_PROGRESS / PLAYER_EVENT, VidZee via
  // its {type,data} pair).
  const passiveClockEmbed =
    mode === "iframe" &&
    (activeSource === "mapple" ||
      activeSource === "vidlink" ||
      activeSource === "vidnest" ||
      activeSource === "2embed" ||
      activeSource === "vidstuck" ||
      activeSource === "vidzee" ||
      activeSource === "vidy");
  const clockEmbed = isDrivenEmbed || passiveClockEmbed;

  /** Native / driven-embed ±10s seek, with a transient on-screen cue. */
  const seekBy = useCallback(
    (side: "left" | "right") => {
      const delta = side === "right" ? 10 : -10;
      navigator.vibrate?.(10);
      if (isDrivenEmbed) {
        sendEmbedSeek(
          clampEmbedTime(remotePositionRef.current + delta)
        );
        setTapCue({ side });
        if (tapCueTimerRef.current) clearTimeout(tapCueTimerRef.current);
        tapCueTimerRef.current = setTimeout(() => setTapCue(null), 650);
        return;
      }
      const v = videoRef.current;
      if (!v || mode !== "native" || !Number.isFinite(v.currentTime)) return;
      const target = Math.max(0, v.currentTime + delta);
      const dur =
        Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      v.currentTime = dur == null ? target : Math.min(target, dur);
      setTapCue({ side });
      if (tapCueTimerRef.current) clearTimeout(tapCueTimerRef.current);
      tapCueTimerRef.current = setTimeout(() => setTapCue(null), 650);
    },
    [isDrivenEmbed, sendEmbedSeek]
  );

  /** Arms the auto-hide timer (shared by bumpChrome and pointer-leave so
   *  leaving the player summons nothing — it just schedules the hide). */
  const armChromeHide = useCallback(() => {
    if (locked) return;
    if (chromeHideTimerRef.current) clearTimeout(chromeHideTimerRef.current);
    const v = videoRef.current;
    const playing = v ? !v.paused : !iframePausedRef.current;
    // Auto-hide only while playing, no menus are open, and the pointer is
    // not resting on the player.
    if (playing) {
      chromeHideTimerRef.current = setTimeout(() => {
        if (
          !subMenuOpen &&
          !audioMenuOpen &&
          !qualityMenuOpen &&
          !serverMenuOpen &&
          !moreMenuOpen &&
          !sourceMenuOpen &&
          !pointerInsideRef.current
        ) {
          setChromeVisible(false);
        }
      }, 3200);
    }
  }, [locked, subMenuOpen, audioMenuOpen, qualityMenuOpen, serverMenuOpen, moreMenuOpen, sourceMenuOpen]);

  const bumpChrome = useCallback(() => {
    if (locked) return;
    setChromeVisible(true);
    armChromeHide();
  }, [locked, armChromeHide]);

  const {
    castReady,
    casting,
    castingRef,
    getCastRemote,
    startCast,
    stopCast,
    castPlayPause,
    castSeekBy,
    endCastForNewMedia,
  } = useCastRemote({
    mode,
    playlistUrl,
    title,
    bumpChrome,
    videoRef,
    remotePositionRef,
    setTransport,
  });

  /** Double-tap ±10s; single tap toggles custom chrome (no native controls). */
  const handleTap = useCallback(
    (e: React.TouchEvent) => {
      if (locked) return;
      // A swipe gesture just ended — don't also flip the chrome.
      if (performance.now() - gestureSuppressUntil.current < 350) return;
      if (mode !== "native" && !isDrivenEmbed) {
        return;
      }
      const t = e.changedTouches[0];
      if (!t) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const side: "left" | "right" =
        t.clientX < rect.left + rect.width / 2 ? "left" : "right";
      const now = performance.now();
      const prev = lastTapRef.current;
      if (prev && prev.side === side && now - prev.time <= 350) {
        lastTapRef.current = null;
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        seekBy(side);
        bumpChrome();
      } else {
        lastTapRef.current = { time: now, side };
        // Defer single-tap chrome toggle so a double-tap can cancel it.
        // Tracked (unlike before) so unmount / src-change clears it — never
        // setState on an unmounted tree.
        if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = setTimeout(() => {
          singleTapTimerRef.current = null;
          if (lastTapRef.current?.time === now) {
            lastTouchChromeRef.current = performance.now();
            setChromeVisible((v) => !v);
            if (!videoRef.current?.paused) bumpChrome();
          }
        }, 360);
      }
    },
    [mode, isDrivenEmbed, locked, seekBy, bumpChrome]
  );

  const handleVideoClick = useCallback(
    (e: React.MouseEvent) => {
      if (locked) return;
      if (mode !== "native" && !isDrivenEmbed) {
        return;
      }
      // Ignore the synthetic click that follows touchend on mobile.
      if (performance.now() - lastTouchChromeRef.current < 500) return;
      // Ignore clicks that originate from chrome buttons (they stopPropagation).
      if ((e.target as HTMLElement).closest("button, input, [role='menu']")) {
        return;
      }
      setChromeVisible((v) => !v);
      bumpChrome();
    },
    [mode, isDrivenEmbed, locked, bumpChrome]
  );

  const handleResume = useCallback(() => {
    const pos = resumePosRef.current || resumePosition || 0;
    setResumeKey(null);
    setResumePosition(null);
    // Driven embeds already loaded at the bookmark via the frame URL — just
    // dismiss and (re)play. Clear the resume floor so live position reports
    // near it aren't mistaken for pre-seek noise.
    if (isDrivenEmbed) {
      resumePosRef.current = 0;
      sendDrivenPlay(true);
      bumpChrome();
      return;
    }
    void seekAndArmSaves(pos);
  }, [resumePosition, seekAndArmSaves, isDrivenEmbed, sendDrivenPlay, bumpChrome]);

  const handleRestart = useCallback(() => {
    clearPosition();
    endedRef.current = false;
    lastSavedPosRef.current = 0;
    resumePosRef.current = 0;
    pendingSeekPosRef.current = null;
    const waiters = pendingSeekWaitersRef.current;
    pendingSeekWaitersRef.current = [];
    for (const w of waiters) w(false);
    holdForResumeRef.current = false;
    saveEnabledRef.current = true;
    setResumeKey(null);
    setResumePosition(null);
    // Driven embeds have no video element: dropping the t= param reloads the
    // frame from 0 (it autoplays). Native path seeks in place.
    if (isDrivenEmbed) {
      setCineSrcT(null);
      bumpChrome();
      return;
    }
    void seekVideo(0);
  }, [clearPosition, seekVideo, isDrivenEmbed, bumpChrome]);

  // Fetch saved position before native playback starts. Block saves and pause
  // autoplay until this resolves so playback cannot start at 0 or wipe a good
  // bookmark while the lookup is pending.
  useEffect(() => {
    const params = playbackParams();
    if (!params) return;
    // Offline download: never gate on the server. The local stop position is
    // the resume point (mirrored below on save) and the outbox still queues
    // server writes for reconnect — but a GET here would pause the first
    // frame for up to 8s (offline included) and could pop Resume over Play.
    if (offlineOverride) {
      resumeLookupDoneRef.current = params;
      holdForResumeRef.current = false;
      saveEnabledRef.current = true;
      resumePosRef.current = 0;
      return;
    }
    if (mode === "iframe") {
      // No cross-origin seek API for the embed — resume via its startAt
      // param instead. Always re-read the server bookmark so a dismissed
      // Continue Watching delete wins over stale detail-page props.
      holdForResumeRef.current = false;
      saveEnabledRef.current = false;
      let cancelled = false;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      waitForPlaybackRequests()
        .then(() =>
          cancelled
            ? null
            : fetch(`/api/playback?${params}`, { signal: controller.signal })
        )
        .then((r) => (r?.ok ? r.json() : null))
        .then(
          (
            data: { positionSeconds?: number; durationSeconds?: number } | null
          ) => {
            if (cancelled) return;
            const pos =
              typeof data?.positionSeconds === "number" &&
              Number.isFinite(data.positionSeconds)
                ? Math.max(0, data.positionSeconds)
                : 0;
            const dur =
              typeof data?.durationSeconds === "number" &&
              Number.isFinite(data.durationSeconds)
                ? Math.max(0, data.durationSeconds)
                : 0;
            if (isResumablePosition(pos, dur)) {
              resumePosRef.current = pos;
              setResumePosition(pos);
              saveEnabledRef.current = true;
            } else {
              resumePosRef.current = 0;
              setResumePosition(null);
              saveEnabledRef.current = true;
            }
          }
        )
        .catch(() => {
          if (!cancelled) saveEnabledRef.current = true;
        })
        .finally(() => window.clearTimeout(timeout));
      return () => {
        cancelled = true;
        controller.abort();
        window.clearTimeout(timeout);
      };
    }
    if (mode !== "native") return;

    // The resume lookup is a per-episode fact. A source switch flips mode
    // (native→loading→native), which re-runs this effect — without this guard
    // it re-arms the hold and re-pops the Resume overlay mid-playback, which
    // freezes the timer and makes the video look like it restarted.
    if (resumeLookupDoneRef.current === params) return;
    // NOTE: the ref is set on COMPLETION (non-cancelled paths below), NOT
    // here — setting it eagerly would let a source switch that lands
    // mid-lookup abort the fetch, skip the re-run, and deadlock the video
    // paused with the hold armed and no overlay to escape through.

    saveEnabledRef.current = false;
    holdForResumeRef.current = true;
    resumePosRef.current = 0;
    videoRef.current?.pause();

    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    const finishWithoutResume = () => {
      if (cancelled) return;
      resumeLookupDoneRef.current = params;
      resumePosRef.current = 0;
      setResumeKey(null);
      setResumePosition(null);
      holdForResumeRef.current = false;
      saveEnabledRef.current = true;
      void videoRef.current?.play().catch(() => {});
    };

    waitForPlaybackRequests()
      .then(() => {
        if (cancelled) return null;
        return fetch(`/api/playback?${params}`, { signal: controller.signal });
      })
      .then((r) => (r?.ok ? r.json() : null))
      .then(
        (
          data: { positionSeconds?: number; durationSeconds?: number } | null
        ) => {
          if (cancelled) return;
          const pos =
            typeof data?.positionSeconds === "number" &&
            Number.isFinite(data.positionSeconds)
              ? Math.max(0, data.positionSeconds)
              : 0;
          const dur =
            typeof data?.durationSeconds === "number" &&
            Number.isFinite(data.durationSeconds)
              ? Math.max(0, data.durationSeconds)
              : 0;
          // Resume only if meaningfully mid-way; near-complete counts as done.
          if (isResumablePosition(pos, dur)) {
            resumeLookupDoneRef.current = params;
            resumePosRef.current = pos;
            setResumeKey(params);
            holdForResumeRef.current = true;
            setResumePosition(pos);
            // Keep saveEnabled false until Resume/Restart.
            return;
          }
          // Stale near-end bookmark — clear so the next open starts clean.
          if (isFinishedPosition(pos, dur)) {
            clearPosition();
          }
          finishWithoutResume();
        }
      )
      .catch(finishWithoutResume)
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
      // If the lookup was aborted mid-flight (source switch landed in the
      // window), it never set resumeLookupDoneRef — release the hold so the
      // video can't deadlock paused. Completed lookups manage their own hold
      // (the resume overlay keeps it armed until Resume/Restart).
      if (resumeLookupDoneRef.current !== params) {
        holdForResumeRef.current = false;
        saveEnabledRef.current = true;
      }
    };
  }, [
    clearPosition,
    mode,
    offlineOverride,
    playbackParams,
  ]);

  // Keep native playback paused while the resume lookup or prompt is active.
  useEffect(() => {
    if (mode !== "native") return;
    const v = videoRef.current;
    if (!v) return;
    const hold = () => {
      if (holdForResumeRef.current) v.pause();
    };
    hold();
    v.addEventListener("play", hold);
    v.addEventListener("loadedmetadata", hold);
    return () => {
      v.removeEventListener("play", hold);
      v.removeEventListener("loadedmetadata", hold);
    };
  }, [mode, playlistUrl]);

  // Rebuffer spinner: mid-playback waiting/stalled/seek stalls (the initial
  // load already has its own pill). Cleared on play/playing/canplay/seek
  // landing — plus a timeupdate failsafe: iOS Safari doesn't reliably
  // re-fire playing/canplay after stall recovery on SW-served offline HLS,
  // but an advancing currentTime is proof frames are moving.
  useEffect(() => {
    if (mode !== "native") return;
    const v = videoRef.current;
    if (!v) return;
    const onStall = () => setBuffering(true);
    const onGo = () => setBuffering(false);
    const onTime = () => {
      if (!v.paused && !v.seeking) setBuffering(false);
    };
    v.addEventListener("waiting", onStall);
    v.addEventListener("stalled", onStall);
    v.addEventListener("seeking", onStall);
    v.addEventListener("play", onGo);
    v.addEventListener("playing", onGo);
    v.addEventListener("canplay", onGo);
    v.addEventListener("seeked", onGo);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("waiting", onStall);
      v.removeEventListener("stalled", onStall);
      v.removeEventListener("seeking", onStall);
      v.removeEventListener("play", onGo);
      v.removeEventListener("playing", onGo);
      v.removeEventListener("canplay", onGo);
      v.removeEventListener("seeked", onGo);
      v.removeEventListener("timeupdate", onTime);
      setBuffering(false);
    };
  }, [mode, playlistUrl]);

  // A Continue Watching CTA supplies the position, so seek directly without
  // putting a second confirmation prompt in front of the user.
  // IMPORTANT: do not enable saves until seek lands (see seekAndArmSaves).
  const autoResumeStartedRef = useRef(false);
  useEffect(() => {
    if (
      !autoResume ||
      mode !== "native" ||
      resumePosition == null ||
      resumeKey !== playbackParams() ||
      autoResumeStartedRef.current
    ) {
      return;
    }
    autoResumeStartedRef.current = true;
    const position = resumePosition;
    // Clear overlay state in microtask (not sync setState-in-effect).
    queueMicrotask(() => {
      setResumeKey(null);
      setResumePosition(null);
    });
    void seekAndArmSaves(position);
  }, [
    autoResume,
    mode,
    playbackParams,
    resumeKey,
    resumePosition,
    seekAndArmSaves,
  ]);

  // Iframe path: no seek API for the embed, so drop any resume prompt.
  useEffect(() => {
    if (mode !== "iframe") return;
    holdForResumeRef.current = false;
  }, [mode]);

  // Offline auto-resume: jump straight to the locally stored stop position
  // (no prompt — explicit user choice for downloads). The target is armed
  // SYNCHRONOUSLY, in an effect that runs before attachNativePlayback, so
  // hls.js opens with startPosition instead of starting at 0 and seeking
  // after attach (that late seek hid the controls behind the spinner).
  // No hold and no resumeSeeking: Play stays mounted and tappable throughout.
  useEffect(() => {
    if (!offlineOverride || offlineResumeDoneRef.current) return;
    offlineResumeDoneRef.current = true;
    // Play once at first readiness even when there is NO bookmark: autoPlay
    // is the primary path, this is the retry if the autoplay policy rejects
    // it (markReady only fires it while the element is still paused).
    holdForResumeRef.current = false;
    saveEnabledRef.current = true;
    advanceNeedsPlayRef.current = true;
    // Nothing resumable — open at 0 with no pending seek.
    if (initialPosition == null) return;
    if (!Number.isFinite(initialPosition) || initialPosition <= RESUME_MIN_SECONDS) return;
    pendingSeekPosRef.current = initialPosition;
    lastSavedPosRef.current = initialPosition;
    lastSavedAtRef.current = Date.now();
  }, [offlineOverride, initialPosition]);

  // ---------- source switching ----------
  const disabledSources = disabledSourcesFor(type);
  const switchSource = useCallback((next: StreamSource) => {
    if (next === activeSource) return;
    // Offline there is no source to switch to: resolution can only fail,
    // re-attach a dead stream and clobber the persisted preference.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const v = videoRef.current;
    const pos =
      v && Number.isFinite(v.currentTime) && v.currentTime > RESUME_MIN_SECONDS
        ? v.currentTime
        : lastSavedPosRef.current > RESUME_MIN_SECONDS
          ? lastSavedPosRef.current
          : remotePositionRef.current > RESUME_MIN_SECONDS
            ? remotePositionRef.current
            : null;
    if (pos != null) {
      pendingSeekPosRef.current = pos;
      // Keep throttle baseline at the real position so tiny pre-seek reports
      // don't pass the min-delta check as "progress".
      lastSavedPosRef.current = pos;
      lastSavedAtRef.current = Date.now();
      // Persist to server before tearing down the video element.
      savePosition(pos, v && Number.isFinite(v.duration) ? v.duration : 0, true);
    } else {
      pendingSeekPosRef.current = null;
      lastSavedPosRef.current = 0;
      lastSavedAtRef.current = 0;
    }
    saveVixSettings({ preferredSource: next });
    setActiveSource(next);
    // Casting follows the old media — end it so the receiver never plays stale.
    endCastForNewMedia();
    // Reset playback state so the resolution effect re-runs fresh. The user
    // picked a source to watch — autoplay when the new stream is ready.
    advanceNeedsPlayRef.current = true;
    setPlaylistUrl(null);
    setThumbnailsUrl(null);
    setMirrorStep(0);
    setStreamFailed(false);
    setStreamError(null);
    setBuffering(false);
    setIframeError(false);
    setAudioTracks([]);
    setAudioTrackId(-1);
    setQualityLevels([]);
    setEffectiveQuality(null);
    setMediaReady(false);
    setIframeCues([]);
    setOpenSubFileId(null);
    setOpenSubItems([]);
    openSubListKeyRef.current = null;
    setCineSrcT(null);
    gestureDirtyVolume.current = null;
    // Source switch (same mount): drop transient gesture state too.
    setBrightness(1);
    setTapCue(null);
    if (tapCueTimerRef.current) {
      clearTimeout(tapCueTimerRef.current);
      tapCueTimerRef.current = null;
    }
    setServerMenuOpen(false);
    setMoreMenuOpen(false);
    setSourceMenuOpen(false);
    // Keep ended/nearEnd so binge overlays don't double-fire after a switch.
    bookmarkClearedRef.current = false;
  }, [activeSource, savePosition, endCastForNewMedia]);

  /** Error-card Retry: re-run stream resolution for the same source. */
  const retryStream = useCallback(() => {
    // Retry means "play it" — autoplay when the stream is ready.
    advanceNeedsPlayRef.current = true;
    setPlaylistUrl(null);
    setThumbnailsUrl(null);
    // Step to the next resolver mirror (no-op for single-playlist sources).
    setMirrorStep((s) => s + 1);
    setStreamFailed(false);
    setStreamError(null);
    setBuffering(false);
    setIframeError(false);
    setMediaReady(false);
    setRetryNonce((n) => n + 1);
    bumpChrome();
  }, [bumpChrome]);

  // Resolve an IMDb id for embed mode (native gets it from resolvers).
  // Declared before ensureOpenSubList / handleOpenSubPick (deps below).
  const ensureIframeImdb = useCallback(async (): Promise<string | null> => {
    if (imdbIdRef.current) return imdbIdRef.current;
    if (!type || !tmdbId) return null;
    try {
      const res = await fetch(
        `/api/imdb?type=${type}&id=${tmdbId}`
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { imdbId?: string | null };
      if (data.imdbId) imdbIdRef.current = data.imdbId;
      return data.imdbId ?? null;
    } catch {
      return null;
    }
  }, [type, tmdbId]);

  // ---------- IntroDB segments fetch (TV only) ----------
  // Needs ensureIframeImdb (defined above). Fetched once per episode (key
  // gate); the reset effect clears the key on title change.
  useEffect(() => {
    if (type !== "tv" || !tmdbId || season == null || episode == null) return;
    const key = `${tmdbId}:${season}:${episode}`;
    // Gate on SUCCESS, not on start: StrictMode double-invokes this effect in
    // dev (setup → cleanup → setup). Marking the key before the async fetch
    // lets the cleanup cancel the only in-flight request while the second run
    // sees the key and returns — no segments ever load.
    if (segmentsKeyRef.current === key) return;
    // Stored segments (captured with the download) win over the network —
    // this is what makes skip/outro work fully offline. The [src] reset seeds
    // them into state; key-marked done so the fetch below never re-runs.
    if (initialSegments) {
      segmentsKeyRef.current = key;
      return;
    }
    let cancelled = false;
    void (async () => {
      const imdb = imdbIdRef.current ?? (await ensureIframeImdb());
      if (cancelled) return;
      if (!imdb) {
        console.warn(`[player] introdb skipped for ${key}: no IMDb id`);
        return;
      }
      const segs = await fetchSegments({ imdbId: imdb, season, episode });
      if (cancelled) return;
      segmentsKeyRef.current = key;
      console.info(`[player] introdb segments for ${key}:`, JSON.stringify(segs));
      setSegments(segs);
    })();
    return () => {
      cancelled = true;
    };
  }, [type, tmdbId, season, episode, mode, playlistUrl, activeSource, ensureIframeImdb, initialSegments]);

  /** Load top-3 file list once per episode (no download quota). */
  const ensureOpenSubList = useCallback(async () => {
    // Whichever provider the menu is showing — the key must include it so
    // switching OpenSubs ↔ SubDL refetches instead of showing stale rows.
    const provider: SubSource =
      subSourceRef.current === "subdl" ? "subdl" : "opensub";
    const key = `${provider}:${season ?? ""}:${episode ?? ""}`;
    if (openSubListKeyRef.current === key && openSubItems.length > 0) return;
    setOpenSubListLoading(true);
    try {
      let items: OpenSubListItem[] = [];
      if (provider === "subdl") {
        // SubDL keys on TMDB ids — no IMDb round-trip needed.
        items = await listSubDl({ tmdbId, type, season, episode });
      } else {
        let imdb = imdbIdRef.current;
        // Embed mode never resolves IMDb via streams — fetch it so the CC menu
        // doesn't strand on "No English files found" for want of an id.
        if (!imdb) imdb = await ensureIframeImdb();
        if (imdb) {
          items = await listOpenSubtitles({
            imdbId: imdb,
            season,
            episode,
          });
        }
      }
      openSubListKeyRef.current = key;
      setOpenSubItems(items);
    } finally {
      setOpenSubListLoading(false);
    }
  }, [season, episode, openSubItems.length, ensureIframeImdb, tmdbId, type]);

  /** Subtitle source picker: persist choice + re-run the subtitle loader. */
  const handleSubSource = useCallback(
    (next: SubSource) => {
      setSubSource(next);
      // Sync the ref synchronously so the immediate reload reads the NEW
      // source (passive useEffect would run only after the commit).
      subSourceRef.current = next;
      setSubError(null);
      if (next !== "opensub" && next !== "subdl") {
        setOpenSubFileId(null);
        setSavedSubAltPick(null);
        setSubMenuOpen(false);
      }
      // subs mirrors the source so applySettings() can drive off/stream
      // (subs === "off" hides; otherwise the language preference applies).
      saveVixSettings({
        subSource: next,
        subs: next === "off" ? "off" : "en",
      });
      // File providers: keep menu open, list top 3, still load best as default.
      if (next === "opensub" || next === "subdl") {
        void ensureOpenSubList();
      }
      reloadSubsRef.current?.();
    },
    [ensureOpenSubList]
  );

  /** User picked one of the top-3 files (OpenSubs or SubDL). */
  const handleOpenSubPick = useCallback(
    async (item: OpenSubListItem) => {
      // Rows come from whichever provider the menu is listing.
      const provider: SubSource =
        subSourceRef.current === "subdl" ? "subdl" : "opensub";
      // Clocked iframe: no <video> track — the iframe-sub effect downloads
      // the picked file once openSubFileId is set.
      if (clockEmbed) {
        // OpenSubs needs an IMDb id; SubDL keys on TMDB ids and doesn't.
        let imdb = imdbIdRef.current;
        if (provider === "opensub" && !imdb) imdb = await ensureIframeImdb();
        if (provider === "opensub" && !imdb) {
          setSubError("Subtitles unavailable");
          return;
        }
        setOpenSubFileId(item.fileId);
        setSubSource(provider);
        subSourceRef.current = provider;
        setSubError(null);
        saveVixSettings({ subSource: provider, subs: "en" });
        setSubMenuOpen(false);
        return;
      }
      const video = videoRef.current;
      const imdb = imdbIdRef.current;
      if (!video || (provider === "opensub" && !imdb)) {
        setSubError("Subtitles unavailable");
        return;
      }
      setOpenSubFileId(item.fileId);
      setSavedSubAltPick(null);
      setSubSource(provider);
      subSourceRef.current = provider;
      setSubError(null);
      saveVixSettings({ subSource: provider, subs: "en" });
      const ext = await fetchExternalVtt({
        source: provider,
        type,
        tmdbId,
        imdbId: imdb ?? null,
        season,
        episode,
        fileId: item.fileId,
        label: item.label,
      });
      if (!ext?.vtt) {
        setSubError("Couldn’t download that subtitle");
        return;
      }
      for (const t of injectedTracksRef.current) t.mode = "disabled";
      injectedTracksRef.current = [];
      externalVttRef.current = { vtt: ext.vtt, label: ext.label };
      setHasExternalSubs(true);
      const delay = loadVixSettings().subDelaySeconds;
      const tr = injectVttTrack(video, ext.vtt, ext.label, true, delay);
      if (tr) injectedTracksRef.current.push(tr);
      setSubMenuOpen(false);
    },
    [season, episode, type, tmdbId, clockEmbed, ensureIframeImdb]
  );

  /** Switch to one of the stored spare subtitle files (offline, no fetch). */
  const handleSavedSubAltPick = useCallback(
    (index: number) => {
      const alt = initialSubAlts?.[index];
      if (!videoRef.current || !alt) {
        setSubError("Subtitles unavailable");
        return;
      }
      setSavedSubAltPick(index);
      setOpenSubFileId(null);
      setSubSource("opensub");
      subSourceRef.current = "opensub";
      setSubError(null);
      saveVixSettings({ subSource: "opensub", subs: "en" });
      // Swap via the engine hook (disables old tracks, injects with current
      // delay) instead of duplicating its track surgery here.
      externalVttRef.current = { vtt: alt.vtt, label: alt.label };
      setHasExternalSubs(true);
      reapplyExternalSubsRef.current?.();
      setSubMenuOpen(false);
    },
    [initialSubAlts]
  );

  // Prefetch the file list when CC menu opens on a file provider.
  useEffect(() => {
    if (subMenuOpen && (subSource === "opensub" || subSource === "subdl")) {
      void ensureOpenSubList();
    }
  }, [subMenuOpen, subSource, ensureOpenSubList]);

  /**
   * Revert the picker to "auto" when a forced external source (VDRK /
   * OpenSubtitles / SubDL) fails to load. Without this the checkmark strands
   * on a dead source and the user sees no subs and no error. Re-run Auto load
   * so stream/VDRK/OS/SubDL cascade actually applies after the revert.
   */
  const revertExternalSub = useCallback((failed: "vdrk" | "opensub" | "subdl") => {
    subSourceRef.current = "auto";
    setSubSource("auto");
    setSubError(
      `${failed === "vdrk" ? "VDRK" : failed === "subdl" ? "SubDL" : "OpenSubtitles"} subtitles unavailable — switched to Auto`
    );
    saveVixSettings({ subSource: "auto", subs: "en" });
    queueMicrotask(() => reloadSubsRef.current?.());
  }, []);

  // ---------- resolve native stream (single fetch, single source of truth) ----------
  useEffect(() => {
    if (!streamable || !tmdbId || !type) return;
    // Offline: play the cached playlist directly, no resolution.
    if (offlineOverride && initialPlaylistUrl) {
      setPlaylistUrl(initialPlaylistUrl);
      setStreamFailed(false);
      return;
    }
    // Embed sources have no native resolver — mode is already "iframe".
    if (isEmbedActive) return;
    let cancelled = false;
    const controller = new AbortController();
    void resolveStreamPlaylist({
      source: activeSource,
      type,
      tmdbId,
      season,
      episode,
      signal: controller.signal,
    }).then((result) => {
      if (cancelled) return;
      imdbIdRef.current = result.imdbId;
      if (result.playlistUrl) {
        // VidSrc.sh returns several signed mirrors of the same title — pick
        // by mirrorStep so Retry rotates instead of re-trying a dead first
        // URL. Single-playlist sources (Vix/Goated) get a 1-entry chain.
        const mirrors = (result.playlistUrls ?? []).filter(
          (u) => u !== result.playlistUrl
        );
        const chain =
          mirrors.length > 0 ? [result.playlistUrl, ...mirrors] : [result.playlistUrl];
        const next = chain[mirrorStep % chain.length] ?? result.playlistUrl;
        hasResolvedRef.current = true;
        setPlaylistUrl(next);
        setThumbnailsUrl(result.thumbnailsUrl ?? null);
        setStreamError(null);
        return;
      }
      if (result.failed) {
        console.warn(
          `[player] ${activeSource} stream resolution failed — falling back to iframe:`,
          result.errorMessage ?? "no playlist",
          result.code ? `(code: ${result.code})` : "",
          result.detail ?? ""
        );
        setStreamError({
          code: result.code,
          detail: result.detail,
          message: result.errorMessage,
          resolverConfigured: result.resolverConfigured,
        });
        setStreamFailed(true);
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [streamable, type, tmdbId, season, episode, activeSource, isEmbedActive, offlineOverride, initialPlaylistUrl, retryNonce, mirrorStep]);

  // ---------- Driven-embed subtitles (VDRK / OpenSubs / SubDL overlay) ----------
  // CineSrc hides its CC menu (controls=false) with no subtitle postMessage
  // API; VidFast has no subtitle commands either — so render our own cues
  // over the iframe, synced to its timeupdate position. VDRK and SubDL need
  // only TMDB ids; OpenSubs needs an IMDb id (resolved lazily via /api/imdb
  // since embeds never resolve).
  useEffect(() => {
    if (!clockEmbed) return;
    if (subSource === "off" || subSource === "stream") {
      setIframeCues([]);
      return;
    }
    if (!type || !tmdbId) return;
    let cancelled = false;
    void (async () => {
      // Forced file provider (or a picked file): download it directly.
      // NOTE: this path never touches the embed player — VidFast/CineSrc
      // only supply the clock. Failures here are our lookup chain, not them.
      if (subSource === "opensub" || subSource === "subdl") {
        const provider: SubSource = subSource;
        let imdb = imdbIdRef.current ?? null;
        if (provider === "opensub" && !imdb) imdb = await ensureIframeImdb();
        if (cancelled) return;
        if (provider === "opensub" && !imdb) {
          setIframeCues([]);
          setSubError("Couldn’t match this title to IMDb — OpenSubs needs it");
          return;
        }
        // Keep the top-3 list fresh for the picker.
        void ensureOpenSubList();
        const ext = await fetchExternalVtt({
          source: provider,
          type,
          tmdbId,
          imdbId: imdb,
          season,
          episode,
          ...(openSubFileId != null ? { fileId: openSubFileId } : {}),
        });
        if (cancelled) return;
        if (!ext?.vtt) {
          setIframeCues([]);
          setSubError(
            provider === "subdl"
              ? "No English SubDL files found for this title"
              : "No English OpenSubtitles files found for this title"
          );
          return;
        }
        // Guard: setting state re-runs this effect — only touch the picker
        // id when it actually changed, or best-download loops forever.
        if (ext.fileId != null && ext.fileId !== openSubFileId) {
          setOpenSubFileId(ext.fileId);
        }
        setIframeCues(parseVttCues(ext.vtt));
        setHasExternalSubs(true);
        setSubError(null);
        return;
      }
      // Auto / VDRK: VDRK first (TMDB ids only), then file providers on Auto.
      const vdrk = await fetchExternalVtt({
        source: "vdrk",
        type,
        tmdbId,
        season,
        episode,
      });
      if (cancelled) return;
      if (vdrk?.vtt) {
        setIframeCues(parseVttCues(vdrk.vtt));
        setHasExternalSubs(true);
        setSubError(null);
        return;
      }
      if (subSource !== "auto") {
        setIframeCues([]);
        setSubError("VDRK subtitles unavailable for this episode");
        return;
      }
      const imdb = imdbIdRef.current ?? (await ensureIframeImdb());
      if (cancelled) return;
      // OpenSubs needs IMDb; skip straight to SubDL when we never got one.
      const os = imdb
        ? await fetchExternalVtt({ source: "opensub", imdbId: imdb, season, episode })
        : null;
      if (cancelled) return;
      if (os?.vtt) {
        setIframeCues(parseVttCues(os.vtt));
        setHasExternalSubs(true);
        setSubError(null);
        return;
      }
      // SubDL keys on TMDB ids — last tier of the Auto cascade.
      const dl = await fetchExternalVtt({
        source: "subdl",
        type,
        tmdbId,
        season,
        episode,
      });
      if (cancelled) return;
      if (dl?.vtt) {
        setIframeCues(parseVttCues(dl.vtt));
        setHasExternalSubs(true);
        setSubError(null);
        return;
      }
      setIframeCues([]);
      setSubError("Subtitles unavailable for this episode");
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clockEmbed,
    subSource,
    openSubFileId,
    type,
    tmdbId,
    season,
    episode,
    ensureIframeImdb,
    ensureOpenSubList,
  ]);

  // ---------- native playback (hls.js / Safari native) ----------
  useEffect(() => {
    if (mode !== "native" || !playlistUrl || !videoRef.current) return;
    return attachNativePlayback({
      video: videoRef.current,
      playlistUrl,
      type,
      tmdbId,
      season,
      episode,
      imdbIdRef,
      pendingSeekPosRef,
      subSourceRef,
      injectedTracksRef,
      externalVttRef,
      reloadSubsRef,
      reapplyExternalSubsRef,
      safariTimerRef,
      setHlsAudioTrackRef,
      setHlsQualityRef,
      setEffectiveQualityRef,
      setAudioTracks,
      setAudioTrackId,
      setQualityLevels,
      setQualitySelection,
      setHasExternalSubs,
      setStreamFailed,
      savePosition,
      revertExternalSub,
      onPendingSeekSettled,
      // Offline with a stored track: engine must not fetch or wipe it.
      // Stable per mount (host remounts per open), listed for correctness.
      offlineStoredSubs: offlineOverride && initialSubVtt != null,
      // Offline downloads recover from holes instead of unmounting.
      offlineKey: offlineKey,
    });
  }, [
    mode,
    playlistUrl,
    savePosition,
    season,
    episode,
    activeSource,
    tmdbId,
    type,
    revertExternalSub,
    onPendingSeekSettled,
    offlineOverride,
    initialSubVtt,
    offlineKey,
  ]);

  // ---------- offline subtitles (stored VTT, never fetched) ----------
  // The engine's own sub cascade would fail offline and surface an error —
  // inject the downloaded track directly and clear any such error instead.
  useEffect(() => {
    if (!offlineOverride || !initialSubVtt) return;
    if (mode !== "native" || !videoRef.current) return;
    const video = videoRef.current;
    // Guard on the ELEMENT, not a boolean: mode switches (native → iframe →
    // native) and reloads remount the <video>, and the tracks die with the
    // old element — a one-shot flag left the re-mount with no subs.
    if (offlineSubInjectedRef.current === video) return;
    // Anything still recorded pointed at the dead element: drop it.
    if (offlineSubInjectedRef.current !== null) injectedTracksRef.current = [];
    offlineSubInjectedRef.current = video;
    // Publish the cached VTT like the online picker paths do — without it the
    // engine's reapply hook bails (empty externalVttRef) and the Subtitle
    // Sync slider was a silent no-op for downloads.
    externalVttRef.current = { vtt: initialSubVtt.vtt, label: initialSubVtt.label };
    const delay = loadVixSettings().subDelaySeconds;
    const tr = injectVttTrack(
      video,
      initialSubVtt.vtt,
      initialSubVtt.label,
      true,
      delay
    );
    if (tr) injectedTracksRef.current.push(tr);
    setHasExternalSubs(true);
    setSubError(null);
  }, [mode, offlineOverride, initialSubVtt]);


  const flushPosition = useCallback(() => {
    if (
      holdForResumeRef.current ||
      endedRef.current ||
      bookmarkClearedRef.current
    ) {
      return Promise.resolve();
    }

    if (mode === "native") {
      const v = videoRef.current;
      if (v && Number.isFinite(v.currentTime) && v.currentTime > 0) {
        savePosition(v.currentTime, v.duration, true);
      }
      return waitForPlaybackRequests();
    }

    if (mode === "iframe" && remotePositionRef.current > 0) {
      // Closing during startAt warmup must not overwrite with a 0–5s report.
      // A real backward scrub is a new bookmark and must flush.
      if (isPreSeekNoise(remotePositionRef.current, resumePosRef.current)) {
        return Promise.resolve();
      }
      savePosition(
        remotePositionRef.current,
        remoteDurationRef.current,
        true
      );
      return waitForPlaybackRequests();
    }
    return Promise.resolve();
  }, [mode, savePosition]);

  // ---------- native video -> event bridge + transport UI ----------
  // Effective rendition reporter (ABR transparency): engine writes the live
  // height, the quality pill reads it. Assigned during render (idempotent —
  // same closure identity per render is fine; engine only calls it).
  setEffectiveQualityRef.current = (h: number | null) => {
    setEffectiveQuality((prev) => (prev === h ? prev : h));
  };

  useEffect(() => {
    if (mode !== "native" || !videoRef.current) return;
    const video = videoRef.current;
    setMediaReady(false);

    const syncTransport = () => {
      setTransport({
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        // Download duration as fallback — keeps the scrub bar rendering and
        // draggable before hls.js has set a finite duration.
        duration:
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : initialDurationRef.current ?? 0,
        paused: video.paused,
        muted: video.muted,
        volume: Number.isFinite(video.volume) ? video.volume : 1,
      });
    };

    const markReady = () => {
      const ready = video.readyState >= 2;
      if (ready) setMediaReady(true);
      // Advance autoplay / offline open: play once the stream can actually
      // play. This setup call runs before hls.js has any data — playing there
      // can reject and would burn the one-shot flag with Play left visible.
      // A live resume hold keeps priority (it pauses us back anyway).
      if (!ready || !advanceNeedsPlayRef.current) return;
      advanceNeedsPlayRef.current = false;
      if (!holdForResumeRef.current && video.paused) {
        void video.play().catch(() => {});
      }
    };

    const onPlay = () => {
      emit("play");
      syncTransport();
      bumpChrome();
    };
    const onPause = () => {
      emit("pause");
      savePosition(video.currentTime, video.duration, true);
      syncTransport();
      setChromeVisible(true);
      if (chromeHideTimerRef.current) clearTimeout(chromeHideTimerRef.current);
    };
    const onSeeked = () => {
      emit("seeked", { t: video.currentTime, duration: video.duration });
      // A manual scrub during the resume hold means the user wants to watch
      // from where they dragged — release the hold and drop the overlay so
      // their seek wins (was: the hold re-paused and froze the timer).
      if (holdForResumeRef.current) {
        holdForResumeRef.current = false;
        saveEnabledRef.current = true;
        setResumePosition(null);
        setResumeKey(null);
      }
      const t = video.currentTime;
      const pending = pendingSeekPosRef.current;
      if (
        pending != null &&
        Number.isFinite(t) &&
        Math.abs(t - pending) > 2.5
      ) {
        pendingSeekPosRef.current = null;
        resumePosRef.current = 0;
        const waiters = pendingSeekWaitersRef.current;
        pendingSeekWaitersRef.current = [];
        for (const w of waiters) w(true);
      }
      savePosition(t, video.duration, true);
      syncTransport();
    };
    const onEnded = () => {
      if (!nearEndFiredRef.current) {
        nearEndFiredRef.current = true;
        onNearEndRef.current?.({ t: video.currentTime, duration: video.duration });
      }
      emit("ended", { t: video.currentTime, duration: video.duration });
      clearPosition();
      syncTransport();
    };
    const onTime = () => {
      // Transport scrubber needs frequent ticks; progress save stays throttled.
      syncTransport();
      const now = Date.now();
      if (now - lastTimeRef.current < 1000) return;
      lastTimeRef.current = now;
      emit("timeupdate");
      savePosition(video.currentTime, video.duration);
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const t = video.currentTime;

      // End-of-content: a known outro start is authoritative (card + watched
      // marking fire there); 96%/92% are fallback ONLY without outro data.
      const outroStartNative = segmentsRef.current.outro?.start ?? null;
      if (
        !nearEndFiredRef.current &&
        (outroStartNative != null
          ? t >= outroStartNative
          : isNearEndPosition(t, dur, NEXT_FAB_RATIO))
      ) {
        nearEndFiredRef.current = true;
        onNearEndRef.current?.({ t, duration: dur });
      }
      if (!endedRef.current && shouldFireEnded(t, dur, outroStartNative)) {
        emit("ended", { t, duration: dur });
        clearPosition();
      }
    };
    const onVol = () => syncTransport();
    const onMeta = () => syncTransport();

    syncTransport();
    markReady();
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("volumechange", onVol);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("loadeddata", markReady);
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", markReady);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("volumechange", onVol);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("loadeddata", markReady);
      video.removeEventListener("canplay", markReady);
      video.removeEventListener("playing", markReady);
      setMediaReady(false);
    };
  }, [mode, emit, savePosition, clearPosition, bumpChrome]);

  type WebkitVideoElement = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
  };

  /** Enter fullscreen with an iPhone Safari video-element fallback. */
  const enterFullscreen = useCallback(() => {
    const root = shellRef.current;
    if (!root || document.fullscreenElement) return;
    try {
      if (root.requestFullscreen) {
        void root.requestFullscreen().catch(() => {
          // Standard request rejected (often iPhone) — try the video element.
          try {
            (videoRef.current as WebkitVideoElement | null)?.webkitEnterFullscreen?.();
          } catch {
            /* no fullscreen available */
          }
        });
        hookWebkitVideoFullscreen();
        return;
      }
    } catch {
      /* fall through to webkit */
    }
    try {
      (videoRef.current as WebkitVideoElement | null)?.webkitEnterFullscreen?.();
    } catch {
      /* no fullscreen available */
    }
    hookWebkitVideoFullscreen();
  }, []);

  /** Exit fullscreen on every engine (standard + iPhone video). */
  const exitFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      (videoRef.current as WebkitVideoElement | null)?.webkitExitFullscreen?.();
    } catch {
      /* ignore */
    }
  }, []);

  /** iPhone Safari fires begin/end on the video element (no bubbling). */
  const hookWebkitVideoFullscreen = useCallback(() => {
    if (webkitFsHooked.current) return;
    const v = videoRef.current as (WebkitVideoElement & {
      addEventListener?: unknown;
    }) | null;
    if (!v || typeof v.addEventListener !== "function") return;
    webkitFsHooked.current = true;
    const onBegin = () => setIsFullscreen(true);
    const onEnd = () => setIsFullscreen(false);
    try {
      (v.addEventListener as EventTarget["addEventListener"]).call(
        v,
        "webkitbeginfullscreen",
        onBegin as EventListener
      );
      (v.addEventListener as EventTarget["addEventListener"]).call(
        v,
        "webkitendfullscreen",
        onEnd as EventListener
      );
    } catch {
      webkitFsHooked.current = false;
    }
  }, []);

  useEffect(() => {
    const onFs = () => {
      const shell = shellRef.current;
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
      };
      const active =
        document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setIsFullscreen(
        !!active &&
          (active === shell ||
            shell?.contains(active) === true ||
            active === videoRef.current)
      );
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  // Netflix-style auto-landscape while fullscreen. Android-only in practice
  // (iOS has no Orientation Lock API); every failure path is silent so
  // unsupported browsers just keep manual rotate. Released on exit/unmount.
  useEffect(() => {
    const orient = screen.orientation as
      | (ScreenOrientation & {
          lock?: (o: string) => Promise<void>;
        })
      | undefined;
    if (isFullscreen && autoRotate) {
      try {
        void orient?.lock?.("landscape")?.catch(() => {});
      } catch {
        /* unsupported — manual rotate */
      }
    } else {
      try {
        orient?.unlock?.();
      } catch {
        /* noop */
      }
    }
  }, [isFullscreen, autoRotate]);

  useEffect(() => {
    return () => {
      try {
        (
          screen.orientation as
            | (ScreenOrientation & { unlock?: () => void })
            | undefined
        )?.unlock?.();
      } catch {
        /* noop */
      }
    };
  }, []);

  const togglePlay = useCallback(() => {
    if (castingRef.current) {
      castPlayPause();
      return;
    }
    if (isDrivenEmbed) {
      sendDrivenPlay(iframePausedRef.current);
      bumpChrome();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
    bumpChrome();
  }, [isDrivenEmbed, sendDrivenPlay, bumpChrome, castPlayPause, castingRef]);

  const seekBySeconds = useCallback(
    (delta: number) => {
      navigator.vibrate?.(10);
      if (castingRef.current && castSeekBy(delta)) {
        bumpChrome();
        return;
      }
      if (isDrivenEmbed) {
        sendEmbedSeek(
          clampEmbedTime(remotePositionRef.current + delta)
        );
        bumpChrome();
        return;
      }
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.currentTime)) return;
      dropPendingSeek();
      const dur =
        Number.isFinite(v.duration) && v.duration > 0
          ? v.duration
          : initialDurationRef.current;
      const target = Math.max(0, v.currentTime + delta);
      v.currentTime = dur != null && dur > 0 ? Math.min(target, dur) : target;
      bumpChrome();
    },
    [isDrivenEmbed, sendEmbedSeek, bumpChrome, dropPendingSeek, castSeekBy, castingRef]
  );

  const seekRatio = useCallback(
    (ratio: number) => {
      if (castingRef.current) {
        try {
          const pair = getCastRemote();
          const remote = pair?.remote;
          if (remote) {
            const dur = remote.duration;
            if (dur > 0) {
              remote.currentTime = Math.max(0, Math.min(dur, ratio * dur));
              pair?.controller.seek();
            }
          }
        } catch {
          /* ignore */
        }
        bumpChrome();
        return;
      }
      if (isDrivenEmbed) {
        const dur = remoteDurationRef.current;
        if (!(dur > 0)) return;
        sendEmbedSeek(Math.max(0, Math.min(dur, ratio * dur)));
        bumpChrome();
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      // The download knows its duration even before hls.js sets one — a
      // silent return here is what made the offline scrub bar look dead.
      const dur =
        Number.isFinite(v.duration) && v.duration > 0
          ? v.duration
          : initialDurationRef.current;
      if (dur == null || !(dur > 0)) return;
      dropPendingSeek();
      v.currentTime = Math.max(0, Math.min(dur, ratio * dur));
      bumpChrome();
    },
    [isDrivenEmbed, sendEmbedSeek, bumpChrome, dropPendingSeek, getCastRemote, castingRef]
  );

  const toggleMute = useCallback(() => {
    if (isDrivenEmbed) {
      const next = !iframeMutedRef.current;
      iframeMutedRef.current = next;
      if (activeSource === "vidfast") {
        sendVidfastCommand(iframeRef.current, "mute", { muted: next });
        window.setTimeout(() => sendVidfastCommand(iframeRef.current, "getStatus"), 350);
      } else {
        sendCineSrcCommand(iframeRef.current, "setMuted", [next]);
      }
      setTransport((t) => ({ ...t, muted: next }));
      bumpChrome();
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    // Session-only mute — never persisted (see vix-settings).
    v.muted = !v.muted;
    bumpChrome();
  }, [isDrivenEmbed, activeSource, bumpChrome]);

  const setVolume = useCallback(
    (vol: number) => {
      const next = Math.max(0, Math.min(1, vol));
      if (isDrivenEmbed) {
        iframeMutedRef.current = next === 0;
        if (activeSource === "vidfast") {
          sendVidfastCommand(iframeRef.current, "volume", { level: next });
          window.setTimeout(() => sendVidfastCommand(iframeRef.current, "getStatus"), 350);
        } else {
          sendCineSrcCommand(iframeRef.current, "setVolume", [next]);
          sendCineSrcCommand(iframeRef.current, "setMuted", [next === 0]);
        }
        setTransport((t) => ({ ...t, volume: next, muted: next === 0 }));
        saveVixSettings({ volume: next });
        bumpChrome();
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      v.volume = next;
      v.muted = next === 0;
      saveVixSettings({ volume: next });
      bumpChrome();
    },
    [isDrivenEmbed, activeSource, bumpChrome]
  );

  /** Cycle screen fill: object-fit on native, CSS zoom on embeds. */
  const cycleScreenFill = useCallback(() => {
    if (mode === "native") {
      const order: VixSettings["videoFit"][] = ["fit", "cover", "stretch"];
      const next = order[(order.indexOf(videoFit) + 1) % order.length] ?? "fit";
      setVideoFit(next);
      saveVixSettings({ videoFit: next });
    } else if (mode === "iframe") {
      const order: VixSettings["embedZoom"][] = [1, 1.25, 1.5];
      const next = order[(order.indexOf(embedZoom) + 1) % order.length] ?? 1;
      setEmbedZoom(next);
      saveVixSettings({ embedZoom: next });
    }
    bumpChrome();
  }, [mode, videoFit, embedZoom, bumpChrome]);

  /** Pick an exact rate (speed presets). Saves global + per-show memory. */
  const pickSpeed = useCallback(
    (rate: number) => {
      const next =
        Number.isFinite(rate) ? Math.min(4, Math.max(0.25, rate)) : 1;
      setPlaybackSpeed(next);
      saveVixSettings(
        showSpeedKey
          ? {
              speed: next,
              speedByShow: {
                ...loadVixSettings().speedByShow,
                [showSpeedKey]: next,
              },
            }
          : { speed: next }
      );
      const cinesrc = mode === "iframe" && activeSource === "cinesrc";
      if (cinesrc) {
        sendCineSrcCommand(iframeRef.current, "setPlaybackRate", [next]);
      } else {
        const v = videoRef.current;
        if (v) v.playbackRate = next;
      }
      bumpChrome();
    },
    [mode, activeSource, showSpeedKey, bumpChrome]
  );

  // Per-show speed memory: when media is ready, a stored show rate wins.
  // Pure updater (no side effects inside setState): StrictMode-safe.
  useEffect(() => {
    if (!mediaReady || !showSpeedKey) return;
    if (appliedShowSpeedRef.current === showSpeedKey) return;
    const remembered = loadVixSettings().speedByShow?.[showSpeedKey];
    if (remembered == null) return;
    appliedShowSpeedRef.current = showSpeedKey;
    const cinesrc = mode === "iframe" && activeSource === "cinesrc";
    if (!cinesrc) {
      const v = videoRef.current;
      if (v && v.playbackRate === remembered) {
        setPlaybackSpeed(remembered);
        return;
      }
    }
    setPlaybackSpeed(remembered);
    if (cinesrc) {
      sendCineSrcCommand(iframeRef.current, "setPlaybackRate", [remembered]);
    } else {
      const v = videoRef.current;
      if (v) v.playbackRate = remembered;
    }
  }, [mediaReady, showSpeedKey, mode, activeSource]);

  // ---------- sleep timer (session-only) ----------
  /** Picked duration in minutes (null = off / after-episode). Drives the
      option check — exact match on choice, immune to countdown drift. */
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);
  const clearSleep = useCallback(() => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    setSleepUntil(null);
    setSleepMinutes(null);
  }, []);
  const fireSleep = useCallback(() => {
    clearSleep();
    if (isDrivenEmbed) {
      sendDrivenPlay(false);
    } else {
      const v = videoRef.current;
      if (v && Number.isFinite(v.currentTime)) {
        savePosition(
          v.currentTime,
          Number.isFinite(v.duration) ? v.duration : 0,
          true
        );
        v.pause();
      }
    }
    bumpChrome();
  }, [clearSleep, isDrivenEmbed, sendDrivenPlay, savePosition, bumpChrome]);
  const pickSleep = useCallback(
    (opt: number | "episode" | null) => {
      clearSleep();
      setSleepAfterEpisode(false);
      if (opt === "episode") {
        // Up Next reads autoplayNext live from settings at episode end.
        setSleepAfterEpisode(true);
        setAutoplayNext(false);
        saveVixSettings({ autoplayNext: false });
        bumpChrome();
        return;
      }
      if (opt == null) {
        bumpChrome();
        return;
      }
      setSleepUntil(Date.now() + opt * 60_000);
      setSleepMinutes(opt);
      sleepTimerRef.current = setTimeout(fireSleep, opt * 60_000);
      bumpChrome();
    },
    [clearSleep, fireSleep, bumpChrome]
  );
  useEffect(
    () => () => {
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
    },
    []
  );

  // ---------- dialogue boost (WebAudio gain, native mode only) ----------
  // One MediaElementSource per element ever — build once, bypass at unity.
  const ensureAudioGraph = useCallback(() => {
    const v = videoRef.current;
    if (!v || audioGraphRef.current) return audioGraphRef.current;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(v);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(ctx.destination);
      audioGraphRef.current = { ctx, gain };
      return audioGraphRef.current;
    } catch {
      return null;
    }
  }, []);
  const applyAudioBoost = useCallback(
    (on: boolean) => {
      setAudioBoost(on);
      saveVixSettings({ audioBoost: on });
      if (!on || mode !== "native") {
        if (audioGraphRef.current) {
          try {
            audioGraphRef.current.gain.gain.value = 1;
          } catch {
            /* ignore */
          }
        }
        bumpChrome();
        return;
      }
      const g = ensureAudioGraph();
      if (g) {
        try {
          if (g.ctx.state === "suspended") void g.ctx.resume();
          g.gain.gain.value = 1.6;
        } catch {
          /* ignore */
        }
      }
      bumpChrome();
    },
    [mode, ensureAudioGraph, bumpChrome]
  );

  // Restore persisted dialogue boost once native media is ready (graph is
  // per-mount; toggle rebuilds it later).
  useEffect(() => {
    if (!mediaReady || mode !== "native" || !audioBoost) return;
    const g = ensureAudioGraph();
    if (g) {
      try {
        if (g.ctx.state === "suspended") void g.ctx.resume();
        g.gain.gain.value = 1.6;
      } catch {
        /* ignore */
      }
    }
  }, [mediaReady, mode, audioBoost, ensureAudioGraph]);
  const toggleBoost = useCallback(() => {
    applyAudioBoost(!audioBoost);
  }, [applyAudioBoost, audioBoost]);
  const toggleAmbilight = useCallback(() => {
    const next = !ambilight;
    setAmbilight(next);
    saveVixSettings({ ambilight: next });
    bumpChrome();
  }, [ambilight, bumpChrome]);

  /** Transient gesture hint bubble (auto-hides). */
  const showGestureHint = useCallback((text: string) => {
    setGestureHint(text);
    if (gestureHintTimer.current) clearTimeout(gestureHintTimer.current);
    gestureHintTimer.current = setTimeout(() => setGestureHint(null), 900);
  }, []);
  useEffect(
    () => () => {
      if (gestureHintTimer.current) clearTimeout(gestureHintTimer.current);
    },
    []
  );

  /**
   * Touch gestures (native mode, unlocked, single touch only):
   * horizontal = seek, left-half vertical = brightness, right-half = volume.
   * Engages past 14px of travel so taps/double-taps still reach handleTap.
   */
  const onVideoTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (locked || mode !== "native" || e.touches.length !== 1) {
        gestureRef.current = null;
        return;
      }
      const t = e.touches[0];
      const v = videoRef.current;
      gestureRef.current = {
        startX: t.clientX,
        startY: t.clientY,
        startVol: v ? v.volume : 1,
        startTime: v && Number.isFinite(v.currentTime) ? v.currentTime : 0,
        active: null,
      };
    },
    [locked, mode]
  );
  const onVideoTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const g = gestureRef.current;
      const v = videoRef.current;
      if (!g || locked || mode !== "native" || !v || e.touches.length !== 1) {
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      if (!g.active) {
        if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        g.active =
          Math.abs(dx) >= Math.abs(dy)
            ? "seek"
            : t.clientX < rect.left + rect.width / 2
              ? "brightness"
              : "volume";
      }
      const dur =
        Number.isFinite(v.duration) && v.duration > 0
          ? v.duration
          : initialDurationRef.current ?? 0;
      if (g.active === "seek" && dur > 0) {
        dropPendingSeek();
        const target = Math.max(0, Math.min(dur, g.startTime + dx / 4));
        v.currentTime = target;
        const m = Math.floor(target / 60);
        const s = Math.floor(target % 60);
        showGestureHint(`${m}:${String(s).padStart(2, "0")}`);
      } else if (g.active === "brightness") {
        // Swipe up = brighter (VLC/MX convention): dy is negative going up.
        const next = Math.min(1, Math.max(0.3, 1 - dy / 300));
        setBrightness(next);
        showGestureHint(`Brightness ${Math.round(next * 100)}%`);
      } else if (g.active === "volume") {
        // Gestures are native-only (guarded above): apply live, persist once
        // on touch end — never localStorage-write per move event.
        const next = Math.min(1, Math.max(0, g.startVol - dy / 300));
        v.volume = next;
        // iPhone Safari ignores programmatic volume (hardware buttons only):
        // detect the locked control and say so instead of faking movement.
        if (
          Math.abs(v.volume - next) > 0.02 &&
          Math.abs(next - g.startVol) > 0.02
        ) {
          showGestureHint("Use side buttons for volume");
        } else {
          v.muted = next === 0;
          setTransport((t) =>
            t.volume === next && t.muted === (next === 0)
              ? t
              : { ...t, volume: next, muted: next === 0 }
          );
          gestureDirtyVolume.current = next;
          showGestureHint(next === 0 ? "Muted" : `Volume ${Math.round(next * 100)}%`);
        }
      }
    },
    [locked, mode, setVolume, showGestureHint, dropPendingSeek]
  );
  const onVideoTouchEnd = useCallback(() => {
    if (gestureRef.current?.active) {
      gestureSuppressUntil.current = performance.now();
      bumpChrome();
    }
    gestureRef.current = null;
    // Persist a gesture-adjusted volume once (see move handler).
    if (gestureDirtyVolume.current != null) {
      saveVixSettings({ volume: gestureDirtyVolume.current });
      gestureDirtyVolume.current = null;
    }
  }, [bumpChrome]);

  // ---------- ambilight (sampled glow behind native video) ----------
  useEffect(() => {
    if (
      mode !== "native" ||
      !ambilight ||
      !mediaReady ||
      typeof window === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const canvas = ambilightCanvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    let stopped = false;
    const tick = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      if (now - last < 120) return;
      if (document.hidden || v.paused || v.readyState < 2) return;
      last = now;
      try {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      } catch {
        /* cross-origin frame — glow stays on last paint */
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [mode, ambilight, mediaReady, playlistUrl]);

  // ---------- lockscreen / bluetooth controls (Media Session API) ----------
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.MediaMetadata === "undefined") {
      return;
    }
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      const label =
        type === "tv" && season != null && episode != null
          ? `${title} — S${season}E${episode}`
          : title;
      ms.metadata = new window.MediaMetadata({
        title: label,
        artist: "LeviOsa",
        album: "LeviOsa",
      });
      ms.setActionHandler("play", () => {
        if (castingRef.current) {
          try {
            getCastRemote()?.controller.playOrPause();
          } catch {
            /* ignore */
          }
          return;
        }
        if (isDrivenEmbed) {
          sendDrivenPlay(true);
          return;
        }
        const v = videoRef.current;
        if (v && mode === "native") void v.play().catch(() => {});
      });
      ms.setActionHandler("pause", () => {
        if (castingRef.current) {
          try {
            getCastRemote()?.controller.playOrPause();
          } catch {
            /* ignore */
          }
          return;
        }
        if (isDrivenEmbed) {
          sendDrivenPlay(false);
          return;
        }
        const v = videoRef.current;
        if (v && mode === "native") v.pause();
      });
      ms.setActionHandler("previoustrack", () => seekBySeconds(-10));
      ms.setActionHandler("nexttrack", () => seekBySeconds(10));
    } catch {
      /* Media Session unsupported — lockscreen falls back to OS default */
    }
    return () => {
      try {
        ms.setActionHandler("play", null);
        ms.setActionHandler("pause", null);
        ms.setActionHandler("previoustrack", null);
        ms.setActionHandler("nexttrack", null);
      } catch {
        /* ignore */
      }
    };
  }, [title, type, season, episode, mode, isDrivenEmbed, sendDrivenPlay, seekBySeconds, getCastRemote, castingRef]);
  // Lockscreen position: transport ticks ~4Hz, but lockscreen IPC is gated
  // to 5s / duration / rate changes.
  useEffect(() => {
    try {
      const ms = navigator.mediaSession;
      const d = transport.duration;
      const p = transport.currentTime;
      if (ms?.setPositionState && d > 0 && p >= 0) {
        const now = Date.now();
        const last = lastPosStateRef.current;
        if (now - last.at >= 5000 || last.dur !== d) {
          lastPosStateRef.current = { at: now, dur: d };
          ms.setPositionState({
            duration: d,
            position: Math.min(p, d),
            playbackRate: playbackSpeed,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }, [transport.currentTime, transport.duration, playbackSpeed]);

  /** Cycle playback speed (native + CineSrc — the only embed with a rate API). */
  const cycleSpeed = useCallback(() => {
    const cinesrc = mode === "iframe" && activeSource === "cinesrc";
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(playbackSpeed);
    const next =
      idx >= 0
        ? (speeds[(idx + 1) % speeds.length] ?? 1)
        : (speeds.find((s) => s > playbackSpeed) ?? 1);
    setPlaybackSpeed(next);
    saveVixSettings({ speed: next });
    if (cinesrc) {
      sendCineSrcCommand(iframeRef.current, "setPlaybackRate", [next]);
    } else {
      const v = videoRef.current;
      if (v) v.playbackRate = next;
    }
    bumpChrome();
  }, [mode, activeSource, playbackSpeed, bumpChrome]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) exitFullscreen();
    else enterFullscreen();
    bumpChrome();
  }, [enterFullscreen, exitFullscreen, bumpChrome]);

  // ---------- iframe fallback: postMessage bridge ----------
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // CineSrc posts cinesrc:* instead of PLAYER_EVENT — normalize the 5
      // events the bridge already consumes.
      let data: unknown = e.data;
      // Vidy posts PLAYER_EVENT / MEDIA_DATA as JSON strings, not objects —
      // unwrap once here so every shape below sees a real payload. Anything
      // that is not a JSON object/array was never handled anyway.
      if (typeof data === "string") {
        const raw = data.trim();
        if (!raw.startsWith("{") && !raw.startsWith("[")) return;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
      }
      // Vidy's docs (and VidZee's playground excerpt) also show the event
      // payload flat — {event, currentTime, duration} with no wrapper. The
      // parser below only accepts {type:"PLAYER_EVENT", data}, so wrap the
      // flat form. Objects that already carry a `type` pass through.
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { type?: unknown }).type == null &&
        typeof (data as { event?: unknown }).event === "string"
      ) {
        data = { type: "PLAYER_EVENT", data };
      }
      if (
        e.origin === "https://cinesrc.st" &&
        typeof e.data === "object" &&
        e.data !== null
      ) {
        const rawType = (e.data as { type?: unknown }).type;
        if (typeof rawType === "string" && rawType.startsWith("cinesrc:")) {
          const ev = rawType.slice("cinesrc:".length);
          const payload = e.data as {
            currentTime?: unknown;
            duration?: unknown;
            volume?: unknown;
            muted?: unknown;
            playbackRate?: unknown;
          };
          if (ev === "ready" || ev === "loadedmetadata") {
            setMediaReady(true);
          }
          // CineSrc reports the server it actually uses (e.g. Nebula).
          // Learn it: the id doubles as the valid `lastserver` value, so
          // discovered servers become switchable picker entries.
          if (ev === "sourceused") {
            const sid = (e.data as { sourceId?: unknown }).sourceId;
            if (typeof sid === "string" && sid.trim()) {
              const id = sid.trim();
              setLiveCineSrcServer(id);
              if (!knownServersRef.current.includes(id)) {
                const next = [...knownServersRef.current, id].slice(0, CINESRC_MAX_KNOWN_SERVERS);
                knownServersRef.current = next;
                setCineSrcKnownServers(next);
                saveVixSettings({ cineSrcKnownServers: next });
              }
            }
          }
          if (ev === "ratechange" && typeof payload.playbackRate === "number") {
            const rate = payload.playbackRate;
            if (Number.isFinite(rate) && rate > 0) {
              setPlaybackSpeed(rate);
              saveVixSettings({ speed: rate });
            }
          }
          if (ev === "volumechange") {
            if (typeof payload.muted === "boolean") {
              iframeMutedRef.current = payload.muted;
            }
            setTransport((t) => ({
              ...t,
              volume:
                typeof payload.volume === "number" ? payload.volume : t.volume,
              muted:
                typeof payload.muted === "boolean" ? payload.muted : t.muted,
            }));
          }
          if (
            (["play", "pause", "seeked", "ended", "timeupdate"] as const).includes(
              ev as "play"
            )
          ) {
            if (ev === "play") iframePausedRef.current = false;
            if (ev === "pause" || ev === "ended") iframePausedRef.current = true;
            if (ev === "play" || ev === "timeupdate") setMediaReady(true);
            setTransport((t) => ({
              ...t,
              currentTime:
                typeof payload.currentTime === "number"
                  ? payload.currentTime
                  : t.currentTime,
              duration:
                typeof payload.duration === "number"
                  ? payload.duration
                  : t.duration,
              paused:
                ev === "play"
                  ? false
                  : ev === "pause" || ev === "ended"
                    ? true
                    : t.paused,
            }));
            if (ev === "play") bumpChrome();
            if (ev === "pause") {
              setChromeVisible(true);
              if (chromeHideTimerRef.current) {
                clearTimeout(chromeHideTimerRef.current);
              }
            }
            data = {
              type: "PLAYER_EVENT",
              data: {
                event: ev,
                currentTime:
                  typeof payload.currentTime === "number"
                    ? payload.currentTime
                    : undefined,
                duration:
                  typeof payload.duration === "number"
                    ? payload.duration
                    : undefined,
              },
            };
          }
        }
      }
      // VidStuck posts {type:"VIDEO_PROGRESS"|"VIDEO_ENDED", payload:{...}}
      // instead of PLAYER_EVENT: a progress tick on every playback event
      // (timeupdate/play/pause/loadedmetadata/volumechange) and a bare
      // VIDEO_ENDED on finish. Fold both into the pipeline below so progress
      // saves, near-end/ended and the passive subtitle clock keep working.
      if (
        (e.origin === "https://vidstuck.xyz" ||
          e.origin.endsWith(".vidstuck.xyz")) &&
        typeof data === "object" &&
        data !== null
      ) {
        const vsType = (data as { type?: unknown }).type;
        if (vsType === "VIDEO_PROGRESS" || vsType === "VIDEO_ENDED") {
          const vsPayload = (data as {
            payload?: { currentTime?: unknown; duration?: unknown };
          }).payload;
          const vsNum = (v: unknown) =>
            typeof v === "number" && Number.isFinite(v) ? v : undefined;
          data = {
            type: "PLAYER_EVENT",
            data: {
              event: vsType === "VIDEO_ENDED" ? "ended" : "timeupdate",
              currentTime: vsNum(vsPayload?.currentTime),
              duration: vsNum(vsPayload?.duration),
            },
          };
        }
      }
      const isPlayerEvent =
        typeof data === "object" &&
        data !== null &&
        (data as { type?: unknown }).type === "PLAYER_EVENT";
      // Nested player frames post from inner windows, so trust any registered
      // embed player origin instead of requiring the exact embed frame/source.
      if (!isEmbedPlayerOrigin(e.origin)) {
        if (isPlayerEvent) warnOnceRejectedPlayerEvent(e.origin);
        return;
      }
      // VidFast enriches PLAYER_EVENT payloads with live state
      // ({ playing, muted, volume }) — read extras once for the blocks below.
      // Its playerstatus reply (getStatus) is outside the 5-event whitelist,
      // so sync from it here and stop before the progress-save path.
      const vfState =
        activeSource === "vidfast" &&
        typeof data === "object" &&
        data !== null &&
        typeof (data as { data?: unknown }).data === "object" &&
        (data as { data?: unknown }).data !== null
          ? ((data as { data?: unknown }).data as {
              event?: unknown;
              playing?: unknown;
              muted?: unknown;
              volume?: unknown;
            })
          : null;
      if (vfState?.event === "playerstatus") {
        const st = vfState as {
          currentTime?: unknown;
          duration?: unknown;
          playing?: unknown;
          muted?: unknown;
          volume?: unknown;
        };
        if (typeof st.currentTime === "number") {
          remotePositionRef.current = st.currentTime;
        }
        if (typeof st.duration === "number" && st.duration > 0) {
          remoteDurationRef.current = st.duration;
        }
        if (typeof st.muted === "boolean") iframeMutedRef.current = st.muted;
        if (typeof st.playing === "boolean") {
          iframePausedRef.current = !st.playing;
        }
        if (
          typeof st.currentTime === "number" ||
          typeof st.duration === "number"
        ) {
          setMediaReady(true);
        }
        setTransport((t) => ({
          ...t,
          currentTime:
            typeof st.currentTime === "number" ? st.currentTime : t.currentTime,
          duration:
            typeof st.duration === "number" && st.duration > 0
              ? st.duration
              : t.duration,
          paused:
            typeof st.playing === "boolean" ? !st.playing : t.paused,
          muted: typeof st.muted === "boolean" ? st.muted : t.muted,
          volume: typeof st.volume === "number" ? st.volume : t.volume,
        }));
        return;
      }

      const d = parseVixPlayerEventData(data);
      if (!d) return;
      emit(d.event, {
        t: typeof d.currentTime === "number" ? d.currentTime : undefined,
        duration: typeof d.duration === "number" ? d.duration : undefined,
      });

      if (typeof d.currentTime === "number") {
        remotePositionRef.current = d.currentTime;
      }
      if (typeof d.duration === "number" && d.duration > 0) {
        remoteDurationRef.current = d.duration;
      }

      // Driven embeds (VidFast + CineSrc) feed our transport clock
      // (play/pause/seek/volume/time). Without this the UI clock freezes at
      // 0:00 — scrubber, time readout, seeker markers and the Skip button all
      // die while progress saves (remote refs above) keep working.
      // Other PLAYER_EVENT embeds (Mapple/VidLink/2Embed/vixsrc fallback) only
      // feed progress below — their chrome stays in charge until locked.
      if (
        (activeSource === "vidfast" || activeSource === "cinesrc") &&
        (d.event === "play" ||
          d.event === "pause" ||
          d.event === "seeked" ||
          d.event === "ended" ||
          d.event === "timeupdate")
      ) {
        // Prefer the payload's live state (autoplay-muted starts never fire
        // a mute event, so event names alone lie about sound).
        const livePlaying =
          typeof vfState?.playing === "boolean" ? vfState.playing : null;
        const liveMuted =
          typeof vfState?.muted === "boolean" ? vfState.muted : null;
        const liveVolume =
          typeof vfState?.volume === "number" ? vfState.volume : null;
        if (livePlaying != null) iframePausedRef.current = !livePlaying;
        else if (d.event === "play") iframePausedRef.current = false;
        else if (d.event === "pause" || d.event === "ended") {
          iframePausedRef.current = true;
        }
        if (liveMuted != null) iframeMutedRef.current = liveMuted;
        if (d.event === "play" || d.event === "timeupdate") setMediaReady(true);
        setTransport((t) => ({
          ...t,
          currentTime:
            typeof d.currentTime === "number" ? d.currentTime : t.currentTime,
          duration:
            typeof d.duration === "number" && d.duration > 0
              ? d.duration
              : t.duration,
          paused:
            livePlaying != null
              ? !livePlaying
              : d.event === "play"
                ? false
                : d.event === "pause" || d.event === "ended"
                  ? true
                  : t.paused,
          muted: liveMuted ?? t.muted,
          volume: liveVolume ?? t.volume,
        }));
        if (d.event === "play") bumpChrome();
        if (d.event === "pause") {
          setChromeVisible(true);
          if (chromeHideTimerRef.current) {
            clearTimeout(chromeHideTimerRef.current);
          }
        }
      }

      // Passive clock embeds have no command channel — sync only the clock
      // so our subtitle overlay can follow it. Transport stays hidden; their
      // player owns control.
      //
      // Their frame also swallows every tap, so once the chrome auto-hides
      // there is no tap surface left to bring it back — use their play/pause
      // announcements instead (pause holds it open, play re-arms the timer).
      // Without this, CC and the subtitle controls bury themselves forever.
      if (passiveClockEmbed) {
        if (d.event === "play") bumpChrome();
        else if (d.event === "pause") {
          setChromeVisible(true);
          if (chromeHideTimerRef.current) {
            clearTimeout(chromeHideTimerRef.current);
          }
        }
      }
      if (
        passiveClockEmbed &&
        (d.event === "timeupdate" || d.event === "seeked")
      ) {
        if (
          typeof d.currentTime === "number" ||
          typeof d.duration === "number"
        ) {
          setMediaReady(true);
        }
        setTransport((t) => ({
          ...t,
          currentTime:
            typeof d.currentTime === "number" ? d.currentTime : t.currentTime,
          duration:
            typeof d.duration === "number" && d.duration > 0
              ? d.duration
              : t.duration,
        }));
      }

      if (d.event === "ended") {
        if (!nearEndFiredRef.current) {
          nearEndFiredRef.current = true;
          onNearEndRef.current?.({
            t: remotePositionRef.current,
            duration: remoteDurationRef.current,
          });
        }
        clearPosition();
        return;
      }

      // End-of-content: a known outro start is authoritative (card + watched
      // marking fire there); 96%/92% are fallback ONLY without outro data.
      const outroStartEmbed = segmentsRef.current.outro?.start ?? null;
      if (
        !nearEndFiredRef.current &&
        (outroStartEmbed != null
          ? remotePositionRef.current >= outroStartEmbed
          : isNearEndPosition(
              remotePositionRef.current,
              remoteDurationRef.current,
              NEXT_FAB_RATIO
            ))
      ) {
        nearEndFiredRef.current = true;
        onNearEndRef.current?.({
          t: remotePositionRef.current,
          duration: remoteDurationRef.current,
        });
      }

      // Auto-complete at the outro start when known, else ~92% (a vixsrc
      // iframe can stall/drift before firing its own "ended", leaving an
      // otherwise-finished watch unmarked). emit("ended") is idempotent, so
      // the dedup guard prevents duplicate marks.
      if (
        !endedRef.current &&
        shouldFireEnded(
          remotePositionRef.current,
          remoteDurationRef.current,
          outroStartEmbed
        )
      ) {
        emit("ended", {
          t: remotePositionRef.current,
          duration: remoteDurationRef.current,
        });
        clearPosition();
        // Skip the resume-bookmark logic below; the item is now complete.
        return;
      }

      if (remotePositionRef.current <= 0) return;

      // Resume gate: startAt can report 0–5s before the embed seeks. A
      // backward scrub (43:00 → 3:00) is the new bookmark — keep it.
      if (resumePosRef.current > 0) {
        if (remotePositionRef.current >= resumePosRef.current - 1) {
          resumePosRef.current = 0;
        } else if (isPreSeekNoise(remotePositionRef.current, resumePosRef.current)) {
          return;
        } else {
          resumePosRef.current = 0;
        }
      }

      if (d.event === "pause" || d.event === "seeked") {
        savePosition(
          remotePositionRef.current,
          remoteDurationRef.current,
          true
        );
      } else if (d.event === "timeupdate") {
        // Persist only positions worth resuming — a sub-5s report (e.g. after
        // a failed resume lookup) must not wipe the existing bookmark.
        if (
          !isResumablePosition(
            remotePositionRef.current,
            remoteDurationRef.current
          )
        ) {
          return;
        }
        savePosition(remotePositionRef.current, remoteDurationRef.current);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [activeSource, bumpChrome, clearPosition, emit, savePosition]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Subtitle/audio menus own Escape while open (capture listener closes them).
      if (subMenuOpen || audioMenuOpen || qualityMenuOpen) return;
      // First Escape exits fullscreen; second closes the player.
      if (document.fullscreenElement) {
        e.preventDefault();
        exitFullscreen();
        return;
      }
      void flushPosition().then(() => {
        onCloseRef.current();
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flushPosition, subMenuOpen, audioMenuOpen, qualityMenuOpen, exitFullscreen]);

  // Desktop keyboard shortcuts (native + driven embeds via command channels).
  // Custom chrome owns transport — no native <video controls> to
  // double-toggle against. Other embeds keep their own keys when focused.
  // Fullscreen is the exception: it only needs the shell, so every mode gets
  // `f`. Passive embeds (Mapple, VidLink, …) have no command channel, so they
  // get nothing else — swallowing keys we can't act on would break their player.
  useEffect(() => {
    // Inline (not the render const below): deps evaluate before it exists.
    const drivenKeys =
      mode === "iframe" &&
      (activeSource === "cinesrc" || activeSource === "vidfast");
    const canFullscreen = mode === "native" || mode === "iframe";
    const transportKeys = mode === "native" || drivenKeys;
    if (locked || !canFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (subMenuOpen || audioMenuOpen || qualityMenuOpen) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === "f") {
        e.preventDefault();
        e.stopPropagation();
        if (document.fullscreenElement) exitFullscreen();
        else enterFullscreen();
        bumpChrome();
        return;
      }
      if (!transportKeys) return;
      if (key === " " || key === "k") {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (key === "ArrowRight" || key === "l") {
        e.preventDefault();
        e.stopPropagation();
        seekBySeconds(10);
      } else if (key === "ArrowLeft" || key === "j") {
        e.preventDefault();
        e.stopPropagation();
        seekBySeconds(-10);
      } else if (key === "m") {
        e.preventDefault();
        e.stopPropagation();
        toggleMute();
      } else if (key === "z") {
        e.preventDefault();
        e.stopPropagation();
        cycleScreenFill();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    mode,
    activeSource,
    locked,
    subMenuOpen,
    audioMenuOpen,
    qualityMenuOpen,
    bumpChrome,
    togglePlay,
    seekBySeconds,
    toggleMute,
    cycleScreenFill,
    enterFullscreen,
    exitFullscreen,
  ]);

  // A click inside a cross-origin embed moves focus into that document, where
  // our window keydown listener never fires — hand focus back whenever our
  // chrome surfaces so `f` keeps working for passive embeds (Mapple & friends).
  // Nothing plays through this document, so blurring can't interrupt playback.
  useEffect(() => {
    if (mode !== "iframe" || isDrivenEmbed || !chromeVisible) return;
    iframeRef.current?.blur();
  }, [mode, isDrivenEmbed, chromeVisible]);

  const adjustSubDelay = useCallback((delta: number) => {
    const next = Math.max(
      -10,
      Math.min(10, Math.round((subDelay + delta) * 2) / 2)
    );
    setSubDelay(next);
    saveVixSettings({ subDelaySeconds: next });
    // Prefer re-timing the cached VTT — do NOT re-fetch (that was the sync bug).
    if (externalVttRef.current && reapplyExternalSubsRef.current) {
      reapplyExternalSubsRef.current();
    }
  }, [subDelay]);

  const patchSubStyle = useCallback(
    (patch: Partial<Pick<VixSettings, "subFontSize" | "subColor" | "subBgOpacity" | "subBgBlur">>) => {
      if (patch.subFontSize) setSubFontSize(patch.subFontSize);
      if (patch.subColor) setSubColor(patch.subColor);
      if (typeof patch.subBgOpacity === "number") setSubBgOpacity(patch.subBgOpacity);
      if (patch.subBgBlur) setSubBgBlur(patch.subBgBlur);
      saveVixSettings(patch);
    },
    []
  );

  // Mobile / tab kill: flush position on hide (keepalive survives the unload).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") flushPosition();
    };
    window.addEventListener("pagehide", flushPosition);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flushPosition);
      document.removeEventListener("visibilitychange", onVis);
      flushPosition();
    };
  }, [flushPosition]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const isLoading = mode === "loading" || (mode === "native" && !mediaReady);
  const hasError = mode === "error";
  // vixIframeBlocked: the fallback frame would only render Cloudflare's
  // block page, so the error card explains both halves (native failed AND
  // the embed is unusable from this host) instead of "Try another source".
  const { title: streamErrorTitle, detail: streamErrorDetail } = vixIframeBlocked
    ? {
        title: "Source unavailable here",
        detail:
          "Native playback failed, and vixsrc blocks its embed from this host, so the fallback can't load either. Try Retry, or switch source.",
      }
    : streamErrorCopy(offlineOverride, streamError);
  const canRetry = streamable || offlineOverride;
  const playbackKey = playbackParams();
  const showResume =
    (mode === "native" || isDrivenEmbed) &&
    mediaReady &&
    !autoResume &&
    resumePosition != null &&
    resumeKey === playbackKey;

  // Driven embeds autoplay under the resume prompt (their URL already seeks
  // via t=) — pause while the choice is up so nothing plays unwatched.
  useEffect(() => {
    if (!showResume || !isDrivenEmbed) return;
    sendDrivenPlay(false);
  }, [showResume, isDrivenEmbed, sendDrivenPlay]);
  const iframeBaseSrc =
    type && tmdbId
      ? embedUrlFor(activeSource, type, tmdbId, season, episode) ?? src
      : src;
  // CineSrc quality switches reload the frame: keep position via t= and
  // apply the preferred-quality param (brief rebuffer, no bookmark loss).
  // Inline (not the render const below): this runs before it is declared.
  const cinesrcFrame = mode === "iframe" && activeSource === "cinesrc";
  let iframeSrc = addStartAt(iframeBaseSrc, cineSrcT ?? resumePosition);
  if (cinesrcFrame && qualitySelection !== "auto") {
    iframeSrc = withCineSrcQuality(iframeSrc, qualitySelection);
  }
  // Stale-hint guard: a stored non-auto hint that matches no discovered real
  // server (e.g. from before discovery existed) can never work — send Auto.
  // The stored value stays until the user picks a real server (then replaced).
  const effectiveCineSrcServer =
    cineSrcServer !== "auto" &&
    cineSrcKnownServers.length > 0 &&
    !cineSrcKnownServers.includes(cineSrcServer)
      ? "auto"
      : cineSrcServer;
  // CineSrc sub-server hint: lastserver + prioritize (Auto clears both).
  if (cinesrcFrame && effectiveCineSrcServer !== "auto") {
    iframeSrc = withCineSrcServer(iframeSrc, effectiveCineSrcServer);
  }
  /**
   * Iframe referrer policy per final frame URL. vixsrc's player refuses an
   * empty referrer (walls with "CANNOT BE EMBEDDED WITH REFERRERPOLICY=
   * NO-REFERRER"), so it gets origin — that is only safe from hosts its WAF
   * allows; blocked hosts never reach this line (vixIframeBlocked -> error
   * card above). Every other source keeps stripped referrers (WAF-safe
   * default); a source that starts walling the same way flips with one
   * referrerPolicy line in its def.
   */
  const iframeReferrerPolicy: "no-referrer" | "origin" = (() => {
    try {
      const host = new URL(iframeSrc, window.location.origin).hostname.toLowerCase();
      if (host === "vixsrc.to" || host.endsWith(".vixsrc.to")) return "origin";
    } catch {
      /* relative/unparseable — fall through to the source default */
    }
    return (
      EMBED_SOURCES.find((s) => s.key === activeSource)?.referrerPolicy ??
      "no-referrer"
    );
  })();
  const handleCineSrcQuality = useCallback(
    (next: "auto" | number) => {
      setQualitySelection(next);
      saveVixSettings({ quality: next });
      setCineSrcT(Math.floor(remotePositionRef.current));
      bumpChrome();
    },
    [bumpChrome]
  );
  /** Sub-server switch: same position-preserving reload as quality switches. */
  const handleCineSrcServer = useCallback(
    (next: string) => {
      setCineSrcServer(next);
      saveVixSettings({ cineSrcServer: next });
      setCineSrcT(Math.floor(remotePositionRef.current));
      bumpChrome();
    },
    [bumpChrome]
  );
  // Intro/recap skip (IntroDB times, TV only). Native + driven embeds only —
  // interactive iframes have no seek API, so the button would be dead there.
  // Rendered inside the shell (fullscreen-safe) and ABOVE the lock overlay
  // (z-40 > z-30): a single deliberate skip tap stays available in lock mode
  // while all other chrome stays buried.
  const skipTarget: { seg: IntroDbSegment; label: string } | null =
    type === "tv" && (mode === "native" || isDrivenEmbed)
      ? segments.intro &&
        transport.currentTime >= segments.intro.start &&
        transport.currentTime < segments.intro.end
        ? { seg: segments.intro, label: "Skip Intro" }
        : segments.recap &&
            transport.currentTime >= segments.recap.start &&
            transport.currentTime < segments.recap.end
          ? { seg: segments.recap, label: "Skip Recap" }
          : null
      : null;
  const skipToTime = useCallback(
    (end: number) => {
      const target = end + 0.5;
      if (mode === "native") {
        void seekVideo(target);
      } else if (isDrivenEmbed) {
        sendEmbedSeek(clampEmbedTime(target));
      }
      bumpChrome();
    },
    [mode, isDrivenEmbed, seekVideo, sendEmbedSeek, bumpChrome]
  );
  // Transport only after media can play — otherwise black screen + fake pause/±10.
  const cineSrcEmbed = mode === "iframe" && activeSource === "cinesrc";
  const showTransport =
    !locked &&
    chromeVisible &&
    (mode === "native" || isDrivenEmbed) &&
    mediaReady &&
    !showResume &&
    !resumeSeeking;

  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} player`}
      className="fixed inset-0 z-[100] flex touch-manipulation flex-col bg-black"
      onPointerEnter={() => {
        pointerInsideRef.current = true;
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
        armChromeHide();
      }}
      onPointerMove={() => bumpChrome()}
    >
      {mode === "native" && (
        <>
          {ambilight && (
            <canvas
              ref={ambilightCanvasRef}
              aria-hidden="true"
              width={32}
              height={18}
              className="pointer-events-none absolute inset-0 z-[5] h-full w-full scale-110 opacity-30 blur-[80px] mix-blend-screen"
            />
          )}
          <video
          ref={videoRef}
          // Custom chrome only — native controls caused dual-layer lock UI.
          controls={false}
          autoPlay
          playsInline
          disablePictureInPicture={false}
          onTouchStart={onVideoTouchStart}
          onTouchMove={onVideoTouchMove}
          onTouchEnd={(e) => {
            onVideoTouchEnd();
            handleTap(e);
          }}
          onClick={handleVideoClick}
          className={`h-full w-full touch-manipulation bg-black ${
            videoFit === "cover"
              ? "object-cover"
              : videoFit === "stretch"
                ? "object-fill"
                : "object-contain"
          }`}
          />
          {brightness < 1 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10 bg-black"
              style={{ opacity: 1 - brightness }}
            />
          )}
          {gestureHint && (
            <div
              role="status"
              className="pointer-events-none absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-sm font-bold tabular-nums text-white backdrop-blur"
            >
              {gestureHint}
            </div>
          )}
        </>
      )}

      {mode === "native" && (
        <SubtitleOverlay
          videoRef={videoRef}
          enabled={subSource !== "off"}
          fontScale={SUB_FONT_SCALE[subFontSize]}
          color={SUB_COLORS[subColor]}
          bgOpacity={subBgOpacity}
          bgBlur={subBgBlur}
          chromeRaised={!locked && chromeVisible}
        />
      )}

      {clockEmbed && subSource !== "off" && subSource !== "stream" && (
        <IframeSubtitleOverlay
          text={cueTextAt(iframeCues, transport.currentTime - subDelay)}
          fontScale={SUB_FONT_SCALE[subFontSize]}
          color={SUB_COLORS[subColor]}
          bgOpacity={subBgOpacity}
          bgBlur={subBgBlur}
          chromeRaised={!locked && chromeVisible}
        />
      )}

      {mode === "iframe" && (
          <div className="h-full w-full overflow-hidden bg-black">
            <iframe
              key={`${iframeSrc}::${retryNonce}`}
            ref={iframeRef}
            src={iframeSrc}
            title={title}
            // vixsrc.to WAF blocks full referers from *.vercel.app, so most
            // sources strip it — except players that refuse an empty referrer
            // (vixsrc itself: use origin). Per-frame policy above.
            referrerPolicy={iframeReferrerPolicy}
            // Permissions policy: a bare `autoplay`/`fullscreen` reads as
            // 'src', so any in-frame redirect to another host silently kills
            // autoplay/fullscreen (Vidy's docs call this out explicitly and
            // require `autoplay *` + `fullscreen *`). The `*` form keeps the
            // grant valid across the redirect chains these players use.
            allow="autoplay *; fullscreen *; encrypted-media; picture-in-picture; clipboard-write"
            allowFullScreen
            // NOTE: no sandbox attribute on purpose — every source gates
            // playback on window.open/navigation working and shows a "disable
            // sandbox" wall otherwise. Popup defense lives in the tap-catcher
            // overlays on driven embeds (CineSrc/VidFast) instead.
            onLoad={() => {
              setIframeError(false);
              // VidFast starts muted under autoplay policy with no
              // unsolicited state event — pull the real state on every load.
              if (vidfastEmbed) {
                sendVidfastCommand(iframeRef.current, "getStatus");
              }
            }}
            onError={() => setIframeError(true)}
            style={
              embedZoom !== 1
                ? { transform: `scale(${embedZoom})` }
                : undefined
            }
            className={`h-full w-full border-0 bg-black ${
              locked || isDrivenEmbed ? "pointer-events-none" : ""
            }`}
          />
        </div>
      )}

      {isDrivenEmbed && !locked && (
        <div
          className="absolute inset-0 z-[15] touch-manipulation"
          onTouchEnd={handleTap}
          onClick={handleVideoClick}
        />
      )}

      {mode === "iframe" && locked && (
        <div className="absolute inset-0 z-30" aria-hidden="true" />
      )}

      {showResume && (
        <ResumeOverlay
          positionSeconds={resumePosition ?? 0}
          onResume={handleResume}
          onRestart={handleRestart}
        />
      )}

      {showTransport && (
        <PlayerTransport
          currentTime={transport.currentTime}
          duration={transport.duration}
          paused={transport.paused}
          muted={transport.muted}
          volume={transport.volume}
          isFullscreen={isFullscreen}
          onTogglePlay={togglePlay}
          onSeekBy={seekBySeconds}
          onSeekRatio={seekRatio}
          onToggleMute={toggleMute}
          onVolume={setVolume}
          onToggleFullscreen={toggleFullscreen}
          showSpeed={mode === "native" || cineSrcEmbed}
          playbackSpeed={playbackSpeed}
          onCycleSpeed={cycleSpeed}
          onPickSpeed={pickSpeed}
          serverOptions={cineSrcEmbed ? buildCineSrcServerOptions(cineSrcKnownServers) : undefined}
          activeServer={liveCineSrcServer ?? cineSrcServer}
          onPickServer={cineSrcEmbed ? handleCineSrcServer : undefined}
          onServerMenuOpenChange={setServerMenuOpen}
          opaqueBottom={activeSource === "vidfast"}
          segments={segments}
          thumbnailsUrl={mode === "native" ? thumbnailsUrl : null}
          showSleep={mode === "native" || isDrivenEmbed}
          sleepUntil={sleepUntil}
          sleepMinutes={sleepMinutes}
          sleepAfterEpisode={sleepAfterEpisode}
          onPickSleep={pickSleep}
        />
      )}

      {/* Skip Intro/Recap (IntroDB times) — inside the shell: fullscreen-safe. */}
      {skipTarget && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            skipToTime(skipTarget.seg.end);
          }}
          aria-label={skipTarget.label}
          className="absolute bottom-28 right-4 z-40 flex h-10 items-center gap-2 rounded-full border border-white/25 bg-black/70 px-4 text-sm font-bold text-white shadow-xl backdrop-blur transition hover:bg-black/90 active:scale-95 sm:bottom-32"
        >
          <SkipForward className="h-4 w-4 fill-white" />
          {skipTarget.label}
        </button>
      )}

      {/* Parent overlays (Up Next, Next FAB, end-of-line) — inside the shell:
          fixed overlays outside the fullscreen element vanish. */}
      {overlaySlot}

      {!locked && chromeVisible && (
        <PlayerTopChrome
          title={title}
          mode={mode}
          activeSource={activeSource}
          streamable={streamable && !offlineOverride}
          videoFit={videoFit}
            embedZoom={embedZoom}
            onCycleScreenFill={cycleScreenFill}
          audioTracks={audioTracks}
          audioTrackId={audioTrackId}
          audioMenuOpen={audioMenuOpen}
          setAudioMenuOpen={setAudioMenuOpen}
          qualityLevels={
            cineSrcEmbed
              ? [
                  { height: 1080, index: 0 },
                  { height: 720, index: 1 },
                  { height: 480, index: 2 },
                ]
              : qualityLevels
          }
          qualitySelection={qualitySelection}
          effectiveQuality={effectiveQuality}
          qualityMenuOpen={qualityMenuOpen}
          setQualityMenuOpen={setQualityMenuOpen}
          onPickQuality={cineSrcEmbed ? handleCineSrcQuality : undefined}
          subSource={subSource}
          subMenuOpen={subMenuOpen}
          setSubMenuOpen={setSubMenuOpen}
          onSubSource={handleSubSource}
          openSubItems={openSubItems}
          openSubFileId={openSubFileId}
          openSubListLoading={openSubListLoading}
          onOpenSubPick={(item) => {
            void handleOpenSubPick(item);
          }}
          savedSubAlts={(initialSubAlts ?? []).map((a) => ({ label: a.label }))}
          savedSubAltIndex={savedSubAltIndex}
          onSavedSubAltPick={handleSavedSubAltPick}
          hasExternalSubs={hasExternalSubs}
          subDelay={subDelay}
          onAdjustSubDelay={adjustSubDelay}
          subFontSize={subFontSize}
          subColor={subColor}
          subBgOpacity={subBgOpacity}
          subBgBlur={subBgBlur}
          onPatchSubStyle={patchSubStyle}
          subError={subError}
          onPickSource={(source) => switchSource(source)}
          sourceOptions={ALL_SOURCES}
          disabledSources={disabledSources}
          showAutoplayToggle={type === "tv"}
          autoplayNext={autoplayNext}
          onToggleAutoplayNext={() => {
            const next = !autoplayNext;
            setAutoplayNext(next);
            saveVixSettings({ autoplayNext: next });
          }}
          sleepUntil={sleepUntil}
          sleepMinutes={sleepMinutes}
          sleepAfterEpisode={sleepAfterEpisode}
          onPickSleep={pickSleep}
          isDrivenEmbed={isDrivenEmbed}
          clockEmbed={clockEmbed}
          audioBoost={audioBoost}
          onToggleBoost={toggleBoost}
          castReady={castReady}
          casting={casting}
          onToggleCast={() => {
            if (casting) stopCast();
            else void startCast();
          }}
          ambilight={ambilight}
          onToggleAmbilight={toggleAmbilight}
            onLock={() => {
              navigator.vibrate?.(10);
            setLockedPersisted(true);
          }}
          onClose={() => {
            setLockedPersisted(false);
            void flushPosition().then(() => {
              onClose();
            });
          }}
          onKeepChrome={() => {
            setChromeVisible(true);
            if (chromeHideTimerRef.current) {
              clearTimeout(chromeHideTimerRef.current);
            }
          }}
          subMenuRef={subMenuRef}
          audioMenuRef={audioMenuRef}
          qualityMenuRef={qualityMenuRef}
          setHlsAudioTrackRef={setHlsAudioTrackRef}
          setHlsQualityRef={setHlsQualityRef}
            onMoreMenuOpenChange={setMoreMenuOpen}
            onSourceMenuOpenChange={setSourceMenuOpen}
          downloadSlot={
            streamable && type && tmdbId ? (
              <DownloadButton
                item={{
                  type,
                  tmdbId,
                  season,
                  episode,
                  title,
                }}
                variant="icon"
              />
            ) : undefined
          }
        />
      )}

      {locked && (
        <UnlockButton
          onUnlock={() => {
            navigator.vibrate?.(10);
            setLockedPersisted(false);
            setChromeVisible(true);
          }}
        />
      )}

      {/* Passive embeds have no tap surface of their own on our side — when
          the chrome auto-hides, this pill is the way back to CC, source
          switch, lock and close (it summons the top chrome for its usual
          auto-hide window; menus keep it open from there). */}
      {mode === "iframe" &&
        !locked &&
        !isDrivenEmbed &&
        !chromeVisible && (
          <button
            type="button"
            aria-label="Show player controls"
            onClick={() => bumpChrome()}
            className="absolute right-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25 backdrop-blur transition hover:bg-black/80 active:scale-95"
          >
            <Captions className="h-5 w-5" />
          </button>
        )}

      {mode === "iframe" && !locked && !isDrivenEmbed && <EmbedHint />}

      {(mode === "native" || isDrivenEmbed) && tapCue && (
        <TapCue side={tapCue.side} />
      )}

      {isLoading && (
        <LoadingPill
          label={
            offlineOverride
              ? "Starting…"
              : `Loading ${sourceLabel(activeSource)}…`
          }
        />
      )}

      {mode === "native" &&
        buffering &&
        mediaReady &&
        !showResume &&
        !transport.paused && <BufferingSpinner />}

      {hasError && (
        <PlayerErrorOverlay
          title={streamErrorTitle}
          detail={streamErrorDetail}
          canRetry={canRetry}
          showTryNext={streamable && !offlineOverride}
          tryNextLabel={sourceLabel(
            nextPlayableSource(activeSource, disabledSources)
          )}
          onRetry={retryStream}
          onClose={() => {
            void flushPosition().then(() => {
              onClose();
            });
          }}
          onTryNext={() => {
            switchSource(nextPlayableSource(activeSource, disabledSources));
          }}
        />
      )}
    </div>
  );
}
