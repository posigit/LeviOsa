"use client";

import type { MutableRefObject, RefObject } from "react";
import {
  AudioLines,
  Captions,
  Cast,
  Check,
  Crop,
  Gauge,
  LockOpen,
  MoonStar,
  MoreHorizontal,
  SkipForward,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useOnline } from "@/components/download-row";
import { cn } from "@/lib/utils";
import { sourceLabel } from "@/lib/embed-sources";
import type { VixSettings } from "@/lib/vix-settings";
import type { OpenSubListItem, SubSource } from "@/lib/player-subs";
import type {
  AudioTrackInfo,
  PlayerMode,
  QualityLevelInfo,
  StreamSource,
} from "@/lib/player-native-types";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  SleepOptionList,
  sleepStatusLabel,
} from "@/components/sleep-options";

type PlayerTopChromeProps = {
  title: string;
  mode: PlayerMode;
  activeSource: StreamSource;
  streamable: boolean;
  isLoading: boolean;
  videoFit: VixSettings["videoFit"];
  embedZoom: VixSettings["embedZoom"];
  onCycleScreenFill: () => void;
  audioTracks: AudioTrackInfo[];
  audioTrackId: number;
  audioMenuOpen: boolean;
  setAudioMenuOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  qualityLevels: QualityLevelInfo[];
  qualitySelection: "auto" | number;
  /** Live ABR rendition height (null = unknown). Shown in Auto mode. */
  effectiveQuality?: number | null;
  qualityMenuOpen: boolean;
  setQualityMenuOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  /** Embed override (CineSrc): reloads the frame with a quality param. */
  onPickQuality?: (quality: "auto" | number) => void;
  subSource: SubSource;
  subMenuOpen: boolean;
  setSubMenuOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  onSubSource: (next: SubSource) => void;
  /** Top OpenSubtitles files (max 3). */
  openSubItems: OpenSubListItem[];
  openSubFileId: number | null;
  openSubListLoading: boolean;
  onOpenSubPick: (item: OpenSubListItem) => void;
  /** Stored subtitle files (downloaded with the item) for offline switching. */
  savedSubAlts: { label: string }[];
  savedSubAltIndex: number | null;
  onSavedSubAltPick: (index: number) => void;
  hasExternalSubs: boolean;
  subDelay: number;
  onAdjustSubDelay: (delta: number) => void;
  subFontSize: VixSettings["subFontSize"];
  subColor: VixSettings["subColor"];
  subBgOpacity: number;
  subBgBlur: VixSettings["subBgBlur"];
  onPatchSubStyle: (
    patch: Partial<
      Pick<
        VixSettings,
        "subFontSize" | "subColor" | "subBgOpacity" | "subBgBlur"
      >
    >
  ) => void;
  subError: string | null;
  onSwitchSource: () => void;
  /** Pick a specific source from the menu (sourceOptions). */
  onPickSource: (source: StreamSource) => void;
  /** All selectable sources for the picker (labels + active marker). */
  sourceOptions: StreamSource[];
  /** Sources that must render disabled (e.g. degraded backends). */
  disabledSources?: StreamSource[];
  /** TV only — toggle 10…0 auto-advance after Up Next appears. */
  showAutoplayToggle?: boolean;
  autoplayNext?: boolean;
  onToggleAutoplayNext?: () => void;
  onLock: () => void;
  onClose: () => void;
  onKeepChrome: () => void;
  /** Offline download button (vix-player supplies it; null when gated off). */
  downloadSlot?: ReactNode;
  subMenuRef: RefObject<HTMLDivElement | null>;
  audioMenuRef: RefObject<HTMLDivElement | null>;
  qualityMenuRef: RefObject<HTMLDivElement | null>;
  setHlsAudioTrackRef: MutableRefObject<((id: number) => void) | null>;
  setHlsQualityRef: MutableRefObject<((next: "auto" | number) => void) | null>;
  /**
   * Reports the mobile More-sheet open state so the parent can keep chrome
   * awake while it is open (same as the other menus).
   */
  onMoreMenuOpenChange?: (open: boolean) => void;
  /** Sleep timer end (ms epoch) or null. */
  sleepUntil?: number | null;
  /** Picked minutes — owns the option check (exact, drift-proof). */
  sleepMinutes?: number | null;
  /** Stop-after-episode armed. */
  sleepAfterEpisode?: boolean;
  /** Set sleep: minutes, "episode", or null to clear. Native + driven embeds. */
  onPickSleep?: (opt: number | "episode" | null) => void;
  /** True for iframe embeds we drive (sleep timer applies to them too). */
  isDrivenEmbed?: boolean;
  /** Dialogue boost on/off (native mode only). */
  audioBoost?: boolean;
  onToggleBoost?: () => void;
  /** Chromecast (native + framework ready). */
  castReady?: boolean;
  casting?: boolean;
  onToggleCast?: () => void;
  /** Ambilight glow toggle (native mode only). */
  ambilight?: boolean;
  onToggleAmbilight?: () => void;
};

/**
 * Top bar: title, speed/audio/quality/CC Look, source switch, lock, close.
 * Transport (play/scrub) lives in PlayerTransport.
 */
export function PlayerTopChrome({
  title,
  mode,
  activeSource,
  streamable,
  isLoading,
  videoFit,
  embedZoom,
  onCycleScreenFill,
  audioTracks,
  audioTrackId,
  audioMenuOpen,
  setAudioMenuOpen,
  qualityLevels,
  qualitySelection,
  effectiveQuality = null,
  qualityMenuOpen,
  setQualityMenuOpen,
  onPickQuality,
  subSource,
  subMenuOpen,
  setSubMenuOpen,
  onSubSource,
  openSubItems,
  openSubFileId,
  openSubListLoading,
  onOpenSubPick,
  savedSubAlts,
  savedSubAltIndex,
  onSavedSubAltPick,
  hasExternalSubs,
  subDelay,
  onAdjustSubDelay,
  subFontSize,
  subColor,
  subBgOpacity,
  subBgBlur,
  onPatchSubStyle,
  subError,
  onSwitchSource,
  onPickSource,
  sourceOptions,
  disabledSources = [],
  showAutoplayToggle = false,
  autoplayNext = true,
  onToggleAutoplayNext,
  onLock,
  onClose,
  onKeepChrome,
  downloadSlot,
  subMenuRef,
  audioMenuRef,
  qualityMenuRef,
  setHlsAudioTrackRef,
  setHlsQualityRef,
  onMoreMenuOpenChange,
  sleepUntil = null,
  sleepMinutes = null,
  sleepAfterEpisode = false,
  onPickSleep,
  isDrivenEmbed = false,
  audioBoost = false,
  onToggleBoost,
  castReady = false,
  casting = false,
  onToggleCast,
  ambilight = false,
  onToggleAmbilight,
}: PlayerTopChromeProps) {
  const online = useOnline();
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [sleepExpanded, setSleepExpanded] = useState(false);
  /** Wall clock for the sleep countdown label (ticks only while visible). */
  const [sleepNow, setSleepNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sleepExpanded || sleepUntil == null) return;
    setSleepNow(Date.now());
    const t = setInterval(() => setSleepNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [sleepExpanded, sleepUntil]);
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  // Outside-dismiss + Escape + scroll — mirrors the sub/audio/quality menus.
  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const node = e.target as Node | null;
      if (sourceMenuRef.current && node && !sourceMenuRef.current.contains(node)) {
        setSourceMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSourceMenuOpen(false);
      }
    };
    const onScroll = () => setSourceMenuOpen(false);
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
  }, [sourceMenuOpen]);
  // Mobile More sheet (overflow for speed/fill/autoplay/autorotate on small
  // portrait screens). Same dismiss + keep-awake contract as other menus.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onMoreMenuOpenChange?.(moreOpen);
  }, [moreOpen, onMoreMenuOpenChange]);
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const node = e.target as Node | null;
      if (moreRef.current && node && !moreRef.current.contains(node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMoreOpen(false);
      }
    };
    const onScroll = () => setMoreOpen(false);
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
  }, [moreOpen]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/90 via-black/50 to-transparent pt-[max(0.5rem,env(safe-area-inset-top))]">
      {/*
        Mobile: title on its own row, controls in a horizontal scroller so
        buttons never clamp over the title (portrait screenshot bug).
        Desktop: classic side-by-side.
      */}
      <div className="flex flex-col gap-2 px-3 pb-8 pt-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-4 sm:pt-3">
        <div className="min-w-0 sm:max-w-[40%]">
          <p className="truncate text-sm font-bold text-white">{title}</p>
          <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">
            {sourceLabel(activeSource)}
          </p>
        </div>
        <div className="pointer-events-auto flex max-w-full shrink-0 items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] sm:flex-wrap sm:justify-end sm:gap-2 sm:overflow-visible sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {downloadSlot}
          {(mode === "native" || mode === "iframe") && (
            <button
              type="button"
              onClick={onCycleScreenFill}
              aria-label="Screen fill mode"
              className="hidden h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-bold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80 sm:flex"
            >
              <Crop className="h-4 w-4" />
              <span className="hidden sm:inline">
                {mode === "native"
                  ? videoFit === "fit"
                    ? "Fit"
                    : videoFit === "cover"
                      ? "Cover"
                      : "Stretch"
                  : `${Math.round(embedZoom * 100)}%`}
              </span>
            </button>
          )}
          {mode === "native" && audioTracks.length > 1 && (
            <div ref={audioMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  onKeepChrome();
                  setAudioMenuOpen((v) => !v);
                  setMoreOpen(false);
                  setSubMenuOpen(false);
                  setQualityMenuOpen(false);
                }}
                aria-label="Audio track"
                aria-expanded={audioMenuOpen}
                className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-bold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
              >
                <Volume2 className="h-4 w-4" />
                <span className="hidden sm:inline">Audio</span>
              </button>
              {audioMenuOpen && (
                <div
                  role="menu"
                  aria-label="Audio tracks"
                  className="fixed inset-x-4 bottom-4 top-auto z-50 max-h-[50vh] w-auto overflow-y-auto rounded-xl border border-white/10 bg-card shadow-xl [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-30 sm:mt-2 sm:w-56 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20"
                >
                  {audioTracks.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setHlsAudioTrackRef.current?.(t.id);
                        setAudioMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm font-medium text-white transition hover:bg-secondary",
                        audioTrackId === t.id && "text-primary"
                      )}
                    >
                      <span className="truncate">
                        {t.name || t.lang || `Track ${t.id}`}
                      </span>
                      {audioTrackId === t.id && (
                        <Check className="h-4 w-4 flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {((mode === "native" && qualityLevels.length > 0) ||
            (mode === "iframe" &&
              activeSource === "cinesrc" &&
              onPickQuality)) && (
            <div ref={qualityMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  onKeepChrome();
                  setQualityMenuOpen((v) => !v);
                  setMoreOpen(false);
                  setSubMenuOpen(false);
                  setAudioMenuOpen(false);
                }}
                aria-label="Quality"
                aria-expanded={qualityMenuOpen}
                className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-bold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
              >
                <Gauge className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {qualitySelection === "auto"
                    ? effectiveQuality != null
                      ? `Auto · ${effectiveQuality}p`
                      : "Auto"
                    : `${qualitySelection}p`}
                </span>
              </button>
              {qualityMenuOpen && (
                <div
                  role="menu"
                  aria-label="Video quality"
                  className="fixed inset-x-4 bottom-4 top-auto z-50 max-h-[50vh] w-auto overflow-y-auto rounded-xl border border-white/10 bg-card shadow-xl [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-30 sm:mt-2 sm:w-44 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      if (onPickQuality) onPickQuality("auto");
                      else setHlsQualityRef.current?.("auto");
                      setQualityMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm font-medium text-white transition hover:bg-secondary",
                      qualitySelection === "auto" && "text-primary"
                    )}
                  >
                    Auto
                    {qualitySelection === "auto" && (
                      <Check className="h-4 w-4 flex-shrink-0" />
                    )}
                  </button>
                  {qualityLevels.map((lv) => (
                    <button
                      key={lv.height}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (onPickQuality) onPickQuality(lv.height);
                        else setHlsQualityRef.current?.(lv.height);
                        setQualityMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm font-medium text-white transition hover:bg-secondary",
                        qualitySelection === lv.height && "text-primary"
                      )}
                    >
                      {lv.height}p
                      {qualitySelection === lv.height && (
                        <Check className="h-4 w-4 flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {(mode === "native" ||
            (mode === "iframe" &&
              (activeSource === "cinesrc" ||
                activeSource === "vidfast" ||
                activeSource === "mapple" ||
                activeSource === "vidlink" ||
                activeSource === "vidnest" ||
                activeSource === "2embed"))) && (
            <div ref={subMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  onKeepChrome();
                  setSubMenuOpen((v) => !v);
                  setMoreOpen(false);
                  setAudioMenuOpen(false);
                  setQualityMenuOpen(false);
                }}
                aria-label="Subtitles"
                aria-expanded={subMenuOpen}
                aria-haspopup="menu"
                className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-bold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
              >
                <Captions className="h-4 w-4" />
                <span className="hidden sm:inline">CC</span>
              </button>
              {subMenuOpen && (
                <div
                  role="menu"
                  aria-label="Subtitles"
                  // overflow-y-auto + max height: was overflow-hidden which
                  // clipped Look (colors/bg) at the bottom of the panel.
                  className="fixed inset-x-4 bottom-4 top-auto z-50 max-h-[min(70vh,28rem)] w-auto overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-card py-1 shadow-xl [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-40 sm:mt-2 sm:w-60 sm:max-w-[calc(100vw-1.5rem)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20"
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                >
                  {(
                    (
                      mode === "iframe"
                        ? [
                            ["auto", "Auto"],
                            ["vdrk", "VDRK"],
                            ["opensub", "OpenSubs"],
                            ["off", "Off"],
                          ]
                        : [
                            ["auto", "Auto"],
                            ["stream", "Stream"],
                            ["vdrk", "VDRK"],
                            ["opensub", "OpenSubs"],
                            ["off", "Off"],
                          ]
                    ) as [SubSource, string][]
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="menuitem"
                      onClick={() => onSubSource(key)}
                      className={cn(
                        "flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm font-semibold text-white hover:bg-secondary",
                        subSource === key &&
                          key !== "opensub" &&
                          "bg-secondary/60 text-primary",
                        subSource === "opensub" &&
                          key === "opensub" &&
                          "bg-secondary/60 text-primary"
                      )}
                    >
                      {label}
                      {subSource === key && (
                        <Check className="h-4 w-4 flex-shrink-0" />
                      )}
                    </button>
                  ))}

                  {/* Stored files (downloaded with the item) — offline switching
                      when the default misaligns. */}
                  {subSource === "opensub" && savedSubAlts.length > 0 && (
                    <div className="border-t border-white/10 py-1">
                      <p className="px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/45">
                        Saved files
                      </p>
                      {savedSubAlts.map((alt, i) => (
                        <button
                          key={`${i}-${alt.label}`}
                          type="button"
                          role="menuitem"
                          onClick={() => onSavedSubAltPick(i)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 px-3.5 py-2 text-left hover:bg-secondary",
                            savedSubAltIndex === i &&
                              "bg-secondary/60 text-primary"
                          )}
                        >
                          <span className="flex items-center justify-between gap-2 text-xs font-semibold text-white">
                            <span className="truncate">
                              {i + 1}. {alt.label}
                            </span>
                            {savedSubAltIndex === i && (
                              <Check className="h-3.5 w-3.5 shrink-0" />
                            )}
                          </span>
                          <span className="text-[10px] font-medium text-white/40">
                            SAVED
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Top 3 OpenSubtitles releases — pick the one that syncs. */}
                  {subSource === "opensub" && (
                    <div className="border-t border-white/10 py-1">
                      <p className="px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/45">
                        Top 3 files
                      </p>
                      {openSubListLoading && (
                        <p className="px-3.5 py-2 text-[11px] text-white/50">
                          Loading…
                        </p>
                      )}
                      {!openSubListLoading && openSubItems.length === 0 && (
                        <p className="px-3.5 py-2 text-[11px] text-white/50">
                          No English files found
                        </p>
                      )}
                      {openSubItems.map((item, i) => (
                        <button
                          key={item.fileId}
                          type="button"
                          role="menuitem"
                          onClick={() => onOpenSubPick(item)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 px-3.5 py-2 text-left hover:bg-secondary",
                            openSubFileId === item.fileId &&
                              "bg-secondary/60 text-primary"
                          )}
                        >
                          <span className="flex items-center justify-between gap-2 text-xs font-semibold text-white">
                            <span className="truncate">
                              {i + 1}. {item.label}
                            </span>
                            {openSubFileId === item.fileId && (
                              <Check className="h-3.5 w-3.5 shrink-0" />
                            )}
                          </span>
                          <span className="text-[10px] font-medium text-white/40">
                            {item.format.toUpperCase()}
                            {item.downloads > 0
                              ? ` · ${item.downloads.toLocaleString()} dl`
                              : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {subSource !== "off" &&
                    (subSource === "vdrk" ||
                      subSource === "opensub" ||
                      hasExternalSubs) && (
                      <div className="flex items-center justify-between border-t border-white/10 px-3.5 py-2.5">
                        <span className="text-xs font-semibold text-white/70">
                          Sync
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAdjustSubDelay(-0.5);
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-sm font-bold text-white"
                            aria-label="Earlier"
                          >
                            −
                          </button>
                          <span className="min-w-[2.75rem] text-center text-xs font-bold tabular-nums text-primary">
                            {subDelay > 0 ? "+" : ""}
                            {subDelay.toFixed(1)}s
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAdjustSubDelay(0.5);
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-sm font-bold text-white"
                            aria-label="Later"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    )}

                  {subSource !== "off" && (
                    <div className="space-y-3 border-t border-white/10 px-3.5 py-3">
                      <div className="flex items-center gap-1.5">
                        {(
                          [
                            ["xs", "75%"],
                            ["sm", "100%"],
                            ["md", "112%"],
                            ["lg", "125%"],
                          ] as const
                        ).map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPatchSubStyle({ subFontSize: key });
                            }}
                            className={cn(
                              "flex h-8 flex-1 items-center justify-center rounded-lg text-[11px] font-bold",
                              subFontSize === key
                                ? "bg-primary text-black"
                                : "bg-secondary text-white"
                            )}
                            aria-label={`Size ${label}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {/* Stack color + bg on separate rows so nothing clips. */}
                      <div className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-white/45">
                          Color
                        </span>
                        {(
                          [
                            ["white", "#fff"],
                            ["yellow", "#ffe566"],
                            ["cyan", "#7dd3fc"],
                          ] as const
                        ).map(([key, hex]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPatchSubStyle({ subColor: key });
                            }}
                            aria-label={key}
                            className={cn(
                              "h-8 w-8 shrink-0 rounded-full ring-2",
                              subColor === key
                                ? "ring-primary"
                                : "ring-white/20"
                            )}
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-white/45">
                          BG
                        </span>
                        {(
                          [
                            [0, "0"],
                            [0.4, "½"],
                            [0.85, "1"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPatchSubStyle({ subBgOpacity: value });
                            }}
                            className={cn(
                              "h-8 min-w-8 flex-1 rounded-lg px-1.5 text-[10px] font-bold",
                              subBgOpacity === value
                                ? "bg-primary text-black"
                                : "bg-secondary text-white"
                            )}
                            aria-label={`Background ${label}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-white/45">
                          Blur
                        </span>
                        {(
                          [
                            ["none", "0"],
                            ["sm", "S"],
                            ["md", "M"],
                            ["lg", "L"],
                          ] as [VixSettings["subBgBlur"], string][]
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPatchSubStyle({ subBgBlur: value });
                            }}
                            className={cn(
                              "h-8 min-w-8 flex-1 rounded-lg px-1.5 text-[10px] font-bold",
                              subBgBlur === value
                                ? "bg-primary text-black"
                                : "bg-secondary text-white"
                            )}
                            aria-label={`Background blur ${label}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {subError && (
                    <p className="border-t border-white/10 px-3.5 py-2 text-[10px] font-medium text-red-400">
                      {subError}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {streamable && (
            <div ref={sourceMenuRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  onKeepChrome();
                  setSourceMenuOpen((v) => !v);
                  setMoreOpen(false);
                }}
                aria-label={`Switch source (currently ${activeSource})`}
                aria-expanded={sourceMenuOpen}
                aria-haspopup="menu"
                className="flex h-9 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-bold text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
              >
                <span className="hidden sm:inline">Source</span>
                <span className="text-white/60">
                  {sourceLabel(activeSource)}
                </span>
              </button>
              {sourceMenuOpen && (
                <div
                  role="menu"
                  aria-label="Stream sources"
                  className="fixed inset-x-4 bottom-4 top-auto z-50 max-h-[min(70vh,28rem)] w-auto overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-white/[0.06] shadow-2xl backdrop-blur-2xl [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:z-30 sm:mt-2 sm:w-48 sm:max-w-[calc(100vw-1.5rem)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20"
                >
                  {sourceOptions.map((key) => {
                    const disabled = disabledSources.includes(key) || !online;
                    // Offline outranks every source; parked backends name
                    // their outage; the generic "Off" covers the rest
                    // (e.g. tv-incompatible embeds).
                    const disabledLabel = !online
                      ? "Offline"
                      : key === "goated"
                        ? "Down"
                        : "Off";
                    return (
                      <button
                        key={key}
                        type="button"
                        role="menuitem"
                        disabled={disabled}
                        onClick={() => {
                          setSourceMenuOpen(false);
                          onPickSource(key);
                        }}
                        className={cn(
                          "flex w-full items-center justify-between px-4 py-2.5 text-left text-sm font-medium text-white transition hover:bg-white/10",
                          activeSource === key && "text-primary",
                          disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
                        )}
                      >
                        {sourceLabel(key)}
                        {disabled && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-white/50">
                            {disabledLabel}
                          </span>
                        )}
                        {!disabled && activeSource === key && (
                          <Check className="h-4 w-4 flex-shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {mode === "native" && castReady && onToggleCast && (
            <button
              type="button"
              onClick={() => {
                onKeepChrome();
                onToggleCast();
              }}
              aria-label={casting ? "Stop casting" : "Cast to TV"}
              aria-pressed={casting}
              title={casting ? "Casting — tap to stop" : "Cast to TV"}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full ring-1 backdrop-blur transition",
                casting
                  ? "bg-primary/25 text-primary ring-primary/50 hover:bg-primary/35"
                  : "bg-black/60 text-white ring-white/20 hover:bg-black/80"
              )}
            >
              <Cast className="h-4 w-4" />
            </button>
          )}
          {showAutoplayToggle && onToggleAutoplayNext && (
            <button
              type="button"
              onClick={() => {
                onKeepChrome();
                onToggleAutoplayNext();
              }}
              aria-label={
                autoplayNext
                  ? "Autoplay next episode on"
                  : "Autoplay next episode off"
              }
              aria-pressed={autoplayNext}
              title={
                autoplayNext
                  ? "Autoplay next: on"
                  : "Autoplay next: off (Up Next still shows)"
              }
              className={cn(
                "hidden h-9 items-center gap-1.5 rounded-full px-3 text-xs font-bold ring-1 backdrop-blur transition sm:flex",
                autoplayNext
                  ? "bg-primary/20 text-primary ring-primary/40 hover:bg-primary/30"
                  : "bg-black/60 text-white/50 ring-white/20 hover:bg-black/80 hover:text-white/80"
              )}
            >
              <SkipForward className="h-4 w-4" />
              <span className="hidden sm:inline">
                {autoplayNext ? "Auto" : "Manual"}
              </span>
            </button>
          )}
          {/* Sleep lives in the bottom transport bar (top stays uncrowded). */}
          {/* Mobile overflow: portrait phones can't fit every pill — fill and
              autoplay hide on small screens and live here with readable
              labels instead. Desktop keeps the full row. */}
          <div className="relative sm:hidden">
            <button
              type="button"
              onClick={() => {
                onKeepChrome();
                setMoreOpen((v) => !v);
                setSubMenuOpen(false);
                setAudioMenuOpen(false);
                setQualityMenuOpen(false);
                setSourceMenuOpen(false);
              }}
              aria-label="More player options"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
            {moreOpen && (
              <div
                ref={moreRef}
                role="menu"
                aria-label="More player options"
                className="fixed inset-x-4 bottom-4 top-auto z-50 overflow-hidden rounded-xl border border-white/15 bg-white/[0.06] py-1 shadow-2xl backdrop-blur-2xl"
              >
                {(mode === "native" || mode === "iframe") && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={onCycleScreenFill}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/10"
                  >
                    <Crop className="h-4 w-4 text-white/60" />
                    Screen fill
                    <span className="ml-auto text-white/60">
                      {mode === "native"
                        ? videoFit === "fit"
                          ? "Fit"
                          : videoFit === "cover"
                            ? "Cover"
                            : "Stretch"
                        : `${Math.round(embedZoom * 100)}%`}
                    </span>
                  </button>
                )}
                {showAutoplayToggle && onToggleAutoplayNext && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onKeepChrome();
                      onToggleAutoplayNext();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/10"
                  >
                    <SkipForward className="h-4 w-4 text-white/60" />
                    Autoplay next
                    <span className="ml-auto text-white/60">
                      {autoplayNext ? "On" : "Off"}
                    </span>
                  </button>
                )}
                {mode === "native" && onToggleBoost && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onKeepChrome();
                      onToggleBoost();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/10"
                  >
                    <AudioLines className="h-4 w-4 text-white/60" />
                    Dialogue boost
                    <span className="ml-auto text-white/60">
                      {audioBoost ? "On" : "Off"}
                    </span>
                  </button>
                )}
                {mode === "native" && onToggleAmbilight && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onKeepChrome();
                      onToggleAmbilight();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/10"
                  >
                    <Sparkles className="h-4 w-4 text-white/60" />
                    Ambilight glow
                    <span className="ml-auto text-white/60">
                      {ambilight ? "On" : "Off"}
                    </span>
                  </button>
                )}
                {(mode === "native" || isDrivenEmbed) && onPickSleep && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      aria-expanded={sleepExpanded}
                      aria-controls="player-sleep-options"
                      onClick={() => {
                        onKeepChrome();
                        setSleepExpanded((v) => !v);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/10"
                    >
                      <MoonStar className="h-4 w-4 text-white/60" />
                      Sleep timer
                      <span className="ml-auto text-white/60">
                        {sleepStatusLabel(sleepAfterEpisode, sleepUntil, sleepNow)}
                      </span>
                    </button>
                    {sleepExpanded && (
                      <div id="player-sleep-options" className="border-t border-white/10 py-1">
                        <SleepOptionList
                          sleepAfterEpisode={sleepAfterEpisode}
                          sleepUntil={sleepUntil}
                          sleepMinutes={sleepMinutes}
                          onPick={(value) => {
                            onPickSleep(value);
                            setSleepExpanded(false);
                          }}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onLock}
            aria-label="Lock player controls"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
          >
            <LockOpen className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close player"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

