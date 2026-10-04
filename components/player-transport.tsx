"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  Maximize,
  Minimize,
  MoonStar,
  Pause,
  Play,
  RotateCcw,
  Server,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  SleepOptionList,
  sleepStatusLabel,
  type SleepOption,
} from "@/components/sleep-options";
import { formatPlayerClock } from "@/lib/player-progress";
import { NEXT_FAB_RATIO } from "@/lib/player-constants";
import { canControlVolume } from "@/lib/player-seek";
import type { IntroDbSegments } from "@/lib/introdb";
import { cn } from "@/lib/utils";

type PlayerTransportProps = {
  currentTime: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  isFullscreen: boolean;
  /** Hide interactive chrome (parent already gates visibility). */
  className?: string;
  onTogglePlay: () => void;
  onSeekBy: (delta: number) => void;
  onSeekRatio: (ratio: number) => void;
  onToggleMute: () => void;
  onVolume: (volume: number) => void;
  onToggleFullscreen: () => void;
  /** Playback-speed cycler (native + CineSrc only — sole rate APIs). */
  showSpeed?: boolean;
  playbackSpeed?: number;
  onCycleSpeed?: () => void;
  /** Exact-rate presets (preferred over cycling when provided). */
  onPickSpeed?: (rate: number) => void;
  /**
   * CineSrc sub-server picker (bottom bar, so the top chrome stays uncrowded).
   * Rendered only when provided (CineSrc driven embed).
   */
  serverOptions?: { id: string; name: string; sub?: string }[];
  activeServer?: string;
  onPickServer?: (id: string) => void;
  /**
   * Sub-servers that failed to start this session (ids, lowercased). Shown as
   * a red "Dead" tag — informational only: a hand-pick retries them (the
   * rotation treats a manual choice as a fresh chance).
   */
  deadServers?: ReadonlySet<string>;
  /**
   * Reports sub-server menu open state so the parent can keep chrome awake
   * while it is open (same as the top CC/audio/quality menus).
   */
  onServerMenuOpenChange?: (open: boolean) => void;
  /**
   * Opaque bottom strip. Driven embeds that keep rendering their own control
   * bar (VidFast has no param to hide it) would otherwise ghost through our
   * translucent gradient — solid black buries it.
   */
  opaqueBottom?: boolean;
  /** IntroDB segments painted as colored ranges behind the scrubber. */
  segments?: IntroDbSegments | null;
  /** Vix seek-preview thumbnails (VTT URL). No bubble when absent/unparseable. */
  thumbnailsUrl?: string | null;
  /**
   * Sleep timer (bottom bar, so the top chrome stays uncrowded on every
   * viewport). Rendered only when provided (native + driven embeds).
   */
  showSleep?: boolean;
  sleepUntil?: number | null;
  /** Picked minutes — owns the option check (exact, drift-proof). */
  sleepMinutes?: number | null;
  sleepAfterEpisode?: boolean;
  onPickSleep?: (opt: SleepOption) => void;
};

type ThumbCue = {
  start: number;
  end: number;
  /** Image URL (resolved against the VTT URL). */
  url: string;
  /** Sprite crop within the image, if the VTT uses #xywh=. */
  crop?: { x: number; y: number; w: number; h: number };
};

function parseTimestamp(ts: string): number | null {
  // Accepts H:MM:SS.mmm, MM:SS.mmm, MM:SS,mmm, and whole-second MM:SS —
  // thumbnail VTTs in the wild omit millis; never silently drop those cues.
  const m = ts.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = m[4] != null ? Number((m[4] + "000").slice(0, 3)) : 0;
  if (![h, min, sec, ms].every(Number.isFinite)) return null;
  if (min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/** Minimal WebVTT cue parser for thumbnail tracks (sprite or plain URLs). */
function parseThumbVtt(text: string, baseUrl: string): ThumbCue[] {
  const cues: ThumbCue[] = [];
  const blocks = text.replace(/^\uFEFF/, "").split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.startsWith("WEBVTT") && !l.startsWith("NOTE"));
    if (lines.length < 2) continue;
    const timing = lines.find((l) => l.includes("-->"));
    const payload = [...lines].reverse().find((l) => !l.includes("-->"));
    if (!timing || !payload) continue;
    const [startRaw, endRaw] = timing.split("-->").map((s) => s.trim());
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw?.split(" ")[0] ?? "");
    if (start == null || end == null || end <= start) continue;
    const [urlRaw, frag] = payload.split("#");
    let url: string;
    try {
      url = new URL(urlRaw, baseUrl).toString();
    } catch {
      continue;
    }
    let crop: ThumbCue["crop"];
    const xywh = frag?.match(/xywh=(\d+),(\d+),(\d+),(\d+)/);
    if (xywh) {
      const [, x, y, w, h] = xywh.map(Number);
      if ([x, y, w, h].every((n) => Number.isFinite(n) && n >= 0) && w > 0 && h > 0) {
        crop = { x, y, w, h };
      }
    }
    cues.push({ start, end, url, crop });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Resolved sprite dims by image URL (content-addressed; survives remounts). */
const spriteDimsCache = new Map<
  string,
  { url: string; w: number; h: number } | null
>;

/** Scrub-hover thumbnail bubble (144×81, sprite-aware). */
function ThumbBubble({
  cue,
  t,
  x,
  spriteDims,
  onSpriteDims,
}: {
  cue: ThumbCue;
  t: number;
  x: number;
  spriteDims: { url: string; w: number; h: number } | null;
  onSpriteDims: (d: { url: string; w: number; h: number } | null) => void;
}) {
  useEffect(() => {
    if (!cue.crop || spriteDims?.url === cue.url) return;
    // Dedupe: resolved dims (or known failures) are cached by URL so rapid
    // scrubbing never re-probes the same sprite.
    if (spriteDimsCache.has(cue.url)) {
      onSpriteDims(spriteDimsCache.get(cue.url) ?? null);
      return;
    }
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (!live) return;
      const dims =
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { url: cue.url, w: img.naturalWidth, h: img.naturalHeight }
          : null;
      spriteDimsCache.set(cue.url, dims);
      onSpriteDims(dims);
    };
    img.onerror = () => {
      if (!live) return;
      spriteDimsCache.set(cue.url, null);
      onSpriteDims(null);
    };
    img.src = cue.url;
    return () => {
      live = false;
    };
  }, [cue.url, cue.crop, spriteDims?.url, onSpriteDims]);
  const dims = spriteDims?.url === cue.url ? spriteDims : null;
  const BW = 144;
  const BH = 81;
  let bgStyle: CSSProperties | null = null;
  if (cue.crop && dims) {
    const scale = BW / cue.crop.w;
    const scaledH = cue.crop.h * scale;
    const top = (BH - scaledH) / 2;
    bgStyle = {
      width: BW,
      height: BH,
      backgroundImage: `url("${cue.url}")`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${dims.w * scale}px ${dims.h * scale}px`,
      backgroundPosition: `-${cue.crop.x * scale}px ${top - cue.crop.y * scale}px`,
    };
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-4 z-30 -translate-x-1/2 overflow-hidden rounded-lg bg-black ring-1 ring-white/25 shadow-2xl"
      style={{
        left: `${Math.min(0.94, Math.max(0.06, x)) * 100}%`,
        width: BW,
        height: BH,
      }}
    >
      {bgStyle ? (
        <div style={bgStyle} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cue.url}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      )}
      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white">
        {formatPlayerClock(t)}
      </span>
    </div>
  );
}

/**
 * Custom native-player transport: center play/±10 + bottom scrubber/volume/FS.
 * Replaces browser <video controls> so lock mode cannot leak native chrome.
 *
 * Volume slider: hidden on iOS (Safari ignores HTMLMediaElement.volume — mute
 * only). Shown on desktop and Android where volume actually works.
 */
export function PlayerTransport({
  currentTime,
  duration,
  paused,
  muted,
  volume,
  isFullscreen,
  className,
  onTogglePlay,
  onSeekBy,
  onSeekRatio,
  onToggleMute,
  onVolume,
  onToggleFullscreen,
  showSpeed = false,
  playbackSpeed = 1,
  onCycleSpeed,
  onPickSpeed,
  serverOptions,
  activeServer = "auto",
  onPickServer,
  deadServers,
  onServerMenuOpenChange,
  opaqueBottom = false,
  segments = null,
  thumbnailsUrl = null,
  showSleep = false,
  sleepUntil = null,
  sleepMinutes = null,
  sleepAfterEpisode = false,
  onPickSleep,
}: PlayerTransportProps) {
  const safeDur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const ratio = safeDur > 0 ? Math.min(1, Math.max(0, currentTime / safeDur)) : 0;
  const remaining = safeDur > 0 ? Math.max(0, safeDur - currentTime) : 0;
  // Colored segment ranges (intro/recap/outro) painted behind the scrubber.
  // Doubled as the "is IntroDB working?" indicator: markers show whenever
  // segments load, even outside the skip window.
  const segMarks =
    safeDur > 0 && segments
      ? (
          [
            { seg: segments.intro, label: "Intro", cls: "bg-purple-400/80" },
            { seg: segments.recap, label: "Recap", cls: "bg-sky-400/80" },
            { seg: segments.outro, label: "Outro", cls: "bg-rose-400/80" },
          ] as const
        )
          .filter((m) => m.seg != null && m.seg.end > m.seg.start)
          .map((m) => {
            const s = m.seg!;
            const left = Math.max(0, Math.min(1, s.start / safeDur));
            const right = Math.max(0, Math.min(1, s.end / safeDur));
            return { ...m, seg: s, left, width: Math.max(0, right - left) };
          })
          .filter((m) => m.width > 0)
      : [];
  // Exact Up Next fire point: outro start when known, else the 96% fallback.
  // The two look different on purpose: a dim tick means "no outro data —
  // 96% fallback", so nobody mistakes the fallback for real timestamps.
  const outroValid =
    segments?.outro != null && segments.outro.end > segments.outro.start;
  const upNextAt =
    safeDur > 0
      ? outroValid
        ? Math.max(0, Math.min(1, segments!.outro!.start / safeDur))
        : NEXT_FAB_RATIO
      : null;
  // UA-based. iOS Safari ignores HTMLMediaElement.volume — mute only.
  // Lazy init: player only mounts client-side after open, so no SSR mismatch.
  const [volumeSupported] = useState(() => canControlVolume(null));
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const serverMenuRef = useRef<HTMLDivElement>(null);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  const sleepMenuRef = useRef<HTMLDivElement>(null);
  /** Wall clock for the sleep countdown label (ticks only while visible). */
  const [sleepNow, setSleepNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sleepMenuOpen || sleepUntil == null) return;
    setSleepNow(Date.now());
    const t = setInterval(() => setSleepNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [sleepMenuOpen, sleepUntil]);
  /** Parsed seek-preview cues (null = none/unparseable → no bubble). */
  const [thumbCues, setThumbCues] = useState<ThumbCue[] | null>(null);
  /** Scrub-hover preview: ratio 0..1 + anchor x fraction, or null. */
  const [scrubPreview, setScrubPreview] = useState<{
    ratio: number;
    x: number;
  } | null>(null);
  const scrubBoxRef = useRef<HTMLDivElement>(null);
  /** Natural dims per sprite URL (for #xywh= crops). */
  const [spriteDims, setSpriteDims] = useState<{
    url: string;
    w: number;
    h: number;
  } | null>(null);
  useEffect(() => {
    if (!thumbnailsUrl) {
      setThumbCues(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    fetch(thumbnailsUrl, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`thumbs ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (ctrl.signal.aborted) return;
        const cues = parseThumbVtt(text, thumbnailsUrl);
        setThumbCues(cues.length > 0 ? cues : null);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setThumbCues(null);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [thumbnailsUrl]);
  const previewCue =
    thumbCues && scrubPreview && safeDur > 0
      ? (() => {
          const t = scrubPreview.ratio * safeDur;
          let lo = 0;
          let hi = thumbCues.length - 1;
          let hit: ThumbCue | null = null;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const c = thumbCues[mid];
            if (t < c.start) hi = mid - 1;
            else if (t >= c.end) lo = mid + 1;
            else {
              hit = c;
              break;
            }
          }
          return hit ? { cue: hit, t } : null;
        })()
      : null;
  const updateScrubPreview = (clientX: number) => {
    const box = scrubBoxRef.current;
    if (!box || !thumbCues || safeDur <= 0) {
      setScrubPreview(null);
      return;
    }
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) {
      setScrubPreview(null);
      return;
    }
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setScrubPreview({ ratio: x, x });
  };
  // Keep parent chrome awake while the menu is open (matches top menus).
  useEffect(() => {
    onServerMenuOpenChange?.(serverMenuOpen);
  }, [serverMenuOpen, onServerMenuOpenChange]);
  const activeServerLabel =
    serverOptions?.find((s) => s.id === activeServer)?.name ?? "Auto";
  // Outside-dismiss + Escape for the bottom-bar menus (mirrors top chrome).
  useEffect(() => {
    if (!serverMenuOpen && !speedMenuOpen && !sleepMenuOpen) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const node = e.target as Node | null;
      const inServer =
        serverMenuRef.current && node && serverMenuRef.current.contains(node);
      const inSpeed =
        speedMenuRef.current && node && speedMenuRef.current.contains(node);
      const inSleep =
        sleepMenuRef.current && node && sleepMenuRef.current.contains(node);
      if (!inServer && !inSpeed && !inSleep) {
        setServerMenuOpen(false);
        setSpeedMenuOpen(false);
        setSleepMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setServerMenuOpen(false);
        setSpeedMenuOpen(false);
        setSleepMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [serverMenuOpen, speedMenuOpen, sleepMenuOpen]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-20",
        className
      )}
    >
      {/* True visual center of the frame (not flex leftover above scrubber). */}
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-6 sm:gap-8">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSeekBy(-10);
          }}
          aria-label="Seek back 10 seconds"
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/75"
        >
          <span className="relative flex h-6 w-6 items-center justify-center">
            <RotateCcw className="h-6 w-6" />
            <span className="absolute text-[9px] font-bold leading-none">10</span>
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePlay();
          }}
          aria-label={paused ? "Play" : "Pause"}
          className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
        >
          {paused ? (
            // Play glyph is optically left-heavy — nudge for true center.
            <Play className="h-7 w-7 translate-x-0.5 fill-white" />
          ) : (
            <Pause className="h-7 w-7 fill-white" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSeekBy(10);
          }}
          aria-label="Seek forward 10 seconds"
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/75"
        >
          <span className="relative flex h-6 w-6 items-center justify-center">
            <RotateCcw className="h-6 w-6 scale-x-[-1]" />
            <span className="absolute text-[9px] font-bold leading-none">10</span>
          </span>
        </button>
      </div>

      {/* Bottom scrubber + volume / FS */}
      <div className={cn("pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10 sm:px-4 sm:pb-4", opaqueBottom ? "bg-black" : "bg-gradient-to-t from-black/90 via-black/50 to-transparent")}>
        <div className="pointer-events-auto flex flex-col gap-2">
          <label className="sr-only" htmlFor="player-seek">
            Seek
          </label>
          <div
            ref={scrubBoxRef}
            className="relative h-1.5 w-full"
            onMouseMove={(e) => updateScrubPreview(e.clientX)}
            onMouseLeave={() => setScrubPreview(null)}
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (t) updateScrubPreview(t.clientX);
            }}
            onTouchMove={(e) => {
              const t = e.touches[0];
              if (t) updateScrubPreview(t.clientX);
            }}
            onTouchEnd={() => setScrubPreview(null)}
          >
            {/* Seek-preview bubble (parsed VTT thumbnails only). */}
            {previewCue && scrubPreview && (
              <ThumbBubble
                cue={previewCue.cue}
                t={previewCue.t}
                x={scrubPreview.x}
                spriteDims={spriteDims}
                onSpriteDims={setSpriteDims}
              />
            )}
            {/* Screen-reader scrub position (the bubble itself is visual-only). */}
            <span className="sr-only" role="status">
              {previewCue
                ? `Preview ${formatPlayerClock(previewCue.t)} of ${formatPlayerClock(safeDur)}`
                : ""}
            </span>
            {/* Segment layer behind the native input: track + fill + marks.
                The input stays fully interactive on top (drag/touch/keys). */}
            <div
              aria-hidden="true"
              className="absolute inset-0 overflow-hidden rounded-full bg-white/25"
            >
              <div
                className="absolute inset-y-0 left-0 bg-primary"
                style={{ width: `${ratio * 100}%` }}
              />
              {segMarks.map((m) => (
                <div
                  key={m.label}
                  title={`${m.label} ${formatPlayerClock(m.seg.start)} – ${formatPlayerClock(m.seg.end)}`}
                  className={`absolute inset-y-0 ${m.cls}`}
                  style={{ left: `${m.left * 100}%`, width: `${m.width * 100}%` }}
                />
              ))}
              {upNextAt != null && (
                <div
                  title={
                    outroValid
                      ? `Up Next (outro ${formatPlayerClock(segments!.outro!.start)})`
                      : "Up Next (96% fallback — no outro data)"
                  }
                  className={`absolute inset-y-0 w-0.5 ${outroValid ? "bg-white" : "bg-white/40"}`}
                  style={{ left: `calc(${upNextAt * 100}% - 1px)` }}
                />
              )}
            </div>
            <input
              id="player-seek"
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(ratio * 1000)}
              aria-valuetext={`${formatPlayerClock(currentTime)} of ${formatPlayerClock(safeDur)}`}
              onChange={(e) => {
                const r = Number(e.target.value) / 1000;
                // Keyboard scrub gets the same preview bubble + announcement.
                setScrubPreview({ ratio: r, x: r });
                onSeekRatio(r);
              }}
              onBlur={() => setScrubPreview(null)}
              onClick={(e) => e.stopPropagation()}
              className="absolute inset-0 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-transparent accent-primary [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
            />
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="min-w-[2.75rem] text-xs font-semibold tabular-nums text-white/90 sm:min-w-[3.25rem]">
              {formatPlayerClock(currentTime)}
            </span>
            <span className="text-xs font-semibold tabular-nums text-white/45">
              -{formatPlayerClock(remaining)}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {showSpeed && (onPickSpeed ?? onCycleSpeed) && (
                <div ref={speedMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onPickSpeed) setSpeedMenuOpen((v) => !v);
                      else onCycleSpeed?.();
                    }}
                    aria-label="Playback speed"
                    aria-expanded={onPickSpeed ? speedMenuOpen : undefined}
                    aria-haspopup={onPickSpeed ? "menu" : undefined}
                    title={`Speed: ${playbackSpeed}×`}
                    className="flex h-9 items-center rounded-full bg-black/50 px-3 text-xs font-bold text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70"
                  >
                    {playbackSpeed}×
                  </button>
                  {onPickSpeed && speedMenuOpen && (
                    <div
                      role="menu"
                      aria-label="Playback speed"
                      className="absolute bottom-full right-0 z-30 mb-2 w-32 overflow-hidden rounded-xl border border-white/15 bg-card py-1 shadow-2xl"
                    >
                      {SPEED_PRESETS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="menuitemradio"
                          aria-checked={playbackSpeed === s}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSpeedMenuOpen(false);
                            onPickSpeed(s);
                          }}
                          className={cn(
                            "flex w-full items-center justify-between px-4 py-2 text-left text-sm font-semibold text-white transition hover:bg-white/10",
                            playbackSpeed === s && "text-primary"
                          )}
                        >
                          {s}×
                          {playbackSpeed === s && (
                            <Check className="h-3.5 w-3.5 flex-shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {serverOptions && onPickServer && (
                <div ref={serverMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setServerMenuOpen((v) => !v);
                    }}
                    aria-label={`Sub-server (currently ${activeServerLabel})`}
                    aria-expanded={serverMenuOpen}
                    aria-haspopup="menu"
                    title={`Server: ${activeServerLabel}`}
                    className="flex h-9 items-center gap-1.5 rounded-full bg-black/50 px-3 text-xs font-bold text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70"
                  >
                    <Server className="h-4 w-4" />
                    <span className="hidden sm:inline">{activeServerLabel}</span>
                  </button>
                  {serverMenuOpen && (
                    <div
                      role="menu"
                      aria-label="Sub-servers"
                      className="absolute bottom-full right-0 z-30 mb-2 max-h-[40vh] w-44 overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-white/[0.06] py-1 shadow-2xl backdrop-blur-2xl [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20"
                    >
                      {serverOptions.map((s) => {
                        const isActive = activeServer === s.id;
                        const dead =
                          !isActive &&
                          deadServers?.has(s.id.toLowerCase()) === true;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              setServerMenuOpen(false);
                              onPickServer(s.id);
                            }}
                            className={cn(
                              "flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm font-medium text-white transition hover:bg-white/10",
                              isActive && "text-primary"
                            )}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{s.name}</span>
                              {s.sub && s.sub !== s.name && (
                                <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-white/40">
                                  {s.sub}
                                </span>
                              )}
                            </span>
                            {dead && (
                              <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide text-red-400">
                                Dead
                              </span>
                            )}
                            {isActive && (
                              <Check className="h-4 w-4 flex-shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {showSleep && onPickSleep && (
                <div ref={sleepMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSleepMenuOpen((v) => !v);
                    }}
                    aria-label="Sleep timer"
                    aria-expanded={sleepMenuOpen}
                    aria-controls="player-sleep-options-bottom"
                    title={`Sleep timer: ${sleepStatusLabel(sleepAfterEpisode, sleepUntil, sleepNow)}`}
                    className={cn(
                      "flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-bold ring-1 backdrop-blur transition",
                      sleepUntil != null || sleepAfterEpisode
                        ? "bg-primary/20 text-primary ring-primary/40 hover:bg-primary/30"
                        : "bg-black/50 text-white ring-white/15 hover:bg-black/70"
                    )}
                  >
                    <MoonStar className="h-4 w-4" />
                    <span className="hidden sm:inline">
                      {sleepStatusLabel(sleepAfterEpisode, sleepUntil, sleepNow)}
                    </span>
                  </button>
                  {sleepMenuOpen && (
                    <div
                      id="player-sleep-options-bottom"
                      role="menu"
                      aria-label="Sleep timer"
                      className="absolute bottom-full right-0 z-30 mb-2 w-48 overflow-hidden rounded-xl border border-white/15 bg-card py-1 shadow-2xl"
                    >
                      <SleepOptionList
                        sleepAfterEpisode={sleepAfterEpisode}
                        sleepUntil={sleepUntil}
                        sleepMinutes={sleepMinutes}
                        onPick={(value) => {
                          onPickSleep(value);
                          setSleepMenuOpen(false);
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
              {/* Volume cluster: the slider widens on hover / keyboard focus
                  (desktop affordance) but keeps its everyday width otherwise —
                  no touch regression, no layout shift when untouched. */}
              <div className="group/vol flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleMute();
                  }}
                  aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70"
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                {volumeSupported && (
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={muted ? 0 : Math.round(volume * 100)}
                    aria-label="Volume"
                    onChange={(e) => onVolume(Number(e.target.value) / 100)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-1 w-16 cursor-pointer appearance-none rounded-full bg-white/25 accent-primary transition-[width] duration-200 ease-out group-hover/vol:w-24 group-focus-within/vol:w-24 sm:w-20 sm:group-hover/vol:w-32 sm:group-focus-within/vol:w-32 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                  />
                )}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFullscreen();
                }}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70"
              >
                {isFullscreen ? (
                  <Minimize className="h-4 w-4" />
                ) : (
                  <Maximize className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
