"use client";

import { useEffect, useState } from "react";
import {
  AudioLines,
  Check,
  Crop,
  FlipHorizontal2,
  Repeat,
  Server,
  SkipForward,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { sourceLabel } from "@/lib/embed-sources";
import type { StreamSource } from "@/lib/player-native-types";
import { useOnline } from "@/components/download-row";
import {
  SleepOptionList,
  sleepStatusLabel,
  type SleepOption,
} from "@/components/sleep-options";
import { SPEED_PRESETS } from "@/components/player-transport";
import type { VixSettings } from "@/lib/vix-settings";

type Tab = "source" | "media" | "playback";

const TABS: { id: Tab; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "media", label: "Media" },
  { id: "playback", label: "Playback" },
];

const BRIGHTNESS_PRESETS: { label: string; value: number }[] = [
  { label: "100%", value: 1 },
  { label: "80%", value: 0.8 },
  { label: "60%", value: 0.6 },
];

export type PlayerSettingsPanelProps = {
  open: boolean;
  onClose: () => void;
  mode: string;
  /** Initial tab (default "Source") — lets a host deep-link a section. */
  initialTab?: Tab;
  /** ---- Source ---- */
  activeSource: StreamSource;
  sourceOptions: StreamSource[];
  disabledSources?: StreamSource[];
  /** Sources in the current failure streak — tagged "Failed" (never the live
   *  one, never a parked one that already says why). */
  failedSourceLabels?: string[];
  streamable: boolean;
  onPickSource: (source: StreamSource) => void;
  /** ---- Media (picture) ---- */
  videoFit: VixSettings["videoFit"];
  embedZoom: VixSettings["embedZoom"];
  onCycleScreenFill: () => void;
  brightness: number;
  onBrightness: (value: number) => void;
  mirrored: boolean;
  onToggleMirror: () => void;
  ambilight?: boolean;
  onToggleAmbilight?: () => void;
  /** ---- Playback ---- */
  playbackSpeed: number;
  onPickSpeed?: (rate: number) => void;
  loopOn: boolean;
  onToggleLoop: () => void;
  showAutoplayToggle?: boolean;
  autoplayNext?: boolean;
  onToggleAutoplayNext?: () => void;
  audioBoost?: boolean;
  onToggleBoost?: () => void;
  showSleep?: boolean;
  sleepUntil?: number | null;
  sleepMinutes?: number | null;
  sleepAfterEpisode?: boolean;
  onPickSleep?: (opt: SleepOption) => void;
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pb-1 pt-4 text-[10px] font-black uppercase tracking-[0.3em] text-white/40">
      {children}
    </p>
  );
}

function SettingRow({
  icon,
  label,
  value,
  checked,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value?: React.ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold text-white transition hover:bg-white/10",
        checked && "text-primary",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
    >
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-white/70">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value != null && (
        <span className="flex-shrink-0 text-xs font-semibold text-white/55">
          {value}
        </span>
      )}
      {checked && <Check className="h-4 w-4 flex-shrink-0" />}
    </button>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-3 pt-1">{children}</div>
  );
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1.5 text-xs font-black ring-1 transition",
        active
          ? "bg-primary text-black ring-primary/50"
          : "bg-white/[0.06] text-white/70 ring-white/15 hover:bg-white/[0.12]"
      )}
    >
      {children}
    </button>
  );
}

/**
 * Grouped player settings: Source / Media / Playback.
 *
 * Rendered inside the player shell (fullscreen-safe), above the chrome, with
 * its own backdrop so the picture behind stays visible. Opening it holds the
 * chrome open (the shell watches `settingsOpen`), Escape and the backdrop both
 * close it, and it unmounts the moment the player errors or locks so it can
 * never sit on top of the error card or the lock screen.
 */
export function PlayerSettingsPanel({
  open,
  onClose,
  mode,
  initialTab,
  activeSource,
  sourceOptions,
  disabledSources = [],
  failedSourceLabels,
  streamable,
  onPickSource,
  videoFit,
  embedZoom,
  onCycleScreenFill,
  brightness,
  onBrightness,
  mirrored,
  onToggleMirror,
  ambilight,
  onToggleAmbilight,
  playbackSpeed,
  onPickSpeed,
  loopOn,
  onToggleLoop,
  showAutoplayToggle,
  autoplayNext,
  onToggleAutoplayNext,
  audioBoost,
  onToggleBoost,
  showSleep,
  sleepUntil = null,
  sleepMinutes = null,
  sleepAfterEpisode = false,
  onPickSleep,
}: PlayerSettingsPanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "source");
  const online = useOnline();
  // Sleep countdown keeps ticking while the panel is open (same 15s cadence as
  // the transport's sleep pill) so the status can't go stale on screen.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const native = mode === "native";

  return (
    <div className="pointer-events-auto absolute inset-0 z-50">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Player settings"
        className="absolute inset-x-3 bottom-3 flex max-h-[82vh] flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/90 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)] backdrop-blur-2xl sm:inset-x-auto sm:bottom-auto sm:right-6 sm:top-16 sm:max-h-[74vh] sm:w-[22rem]"
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <p className="flex-1 text-sm font-black tracking-tight text-white">
            Settings
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] text-white/70 ring-1 ring-white/15 transition hover:bg-white/[0.16] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div role="tablist" aria-label="Settings sections" className="flex gap-1 border-b border-white/10 p-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "flex-1 rounded-lg px-3 py-2 text-xs font-black transition",
                tab === item.id
                  ? "bg-white/[0.12] text-white"
                  : "text-white/50 hover:bg-white/[0.06] hover:text-white/80"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain pb-4 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20">
          {tab === "source" && (
            <>
              <SectionLabel>Stream source</SectionLabel>
              {streamable ? (
                sourceOptions.map((key) => {
                  const disabled = disabledSources.includes(key) || !online;
                  const disabledLabel = !online
                    ? "Offline"
                    : key === "goated"
                      ? "Down"
                      : "Off";
                  const failed =
                    !disabled &&
                    activeSource !== key &&
                    failedSourceLabels?.includes(sourceLabel(key)) === true;
                  return (
                    <SettingRow
                      key={key}
                      icon={<Server className="h-4 w-4" />}
                      label={sourceLabel(key)}
                      value={
                        disabled ? (
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-white/50">
                            {disabledLabel}
                          </span>
                        ) : activeSource === key ? (
                          "Playing"
                        ) : failed ? (
                          <span className="text-[10px] font-bold uppercase tracking-wide text-red-400">
                            Failed
                          </span>
                        ) : undefined
                      }
                      checked={!disabled && activeSource === key}
                      disabled={disabled}
                      onClick={() => {
                        onPickSource(key);
                        onClose();
                      }}
                    />
                  );
                })
              ) : (
                <p className="px-4 py-3 text-sm text-white/50">
                  This stream isn’t switchable right now.
                </p>
              )}
            </>
          )}

          {tab === "media" && (
            <>
              <SectionLabel>Picture</SectionLabel>
              <SettingRow
                icon={<Crop className="h-4 w-4" />}
                label="Screen fill"
                value={
                  native
                    ? videoFit === "fit"
                      ? "Fit"
                      : videoFit === "cover"
                        ? "Cover"
                        : "Stretch"
                    : `${Math.round(embedZoom * 100)}%`
                }
                onClick={onCycleScreenFill}
              />

              {native && (
                <>
                  <SectionLabel>Brightness</SectionLabel>
                  <ChipRow>
                    {BRIGHTNESS_PRESETS.map((preset) => (
                      <Chip
                        key={preset.value}
                        active={Math.abs(brightness - preset.value) < 0.01}
                        onClick={() => onBrightness(preset.value)}
                      >
                        {preset.label}
                      </Chip>
                    ))}
                  </ChipRow>

                  <SectionLabel>Flip &amp; glow</SectionLabel>
                  <SettingRow
                    icon={<FlipHorizontal2 className="h-4 w-4" />}
                    label="Mirror picture"
                    value={mirrored ? "On" : "Off"}
                    checked={mirrored}
                    onClick={onToggleMirror}
                  />
                  {onToggleAmbilight && (
                    <SettingRow
                      icon={<Sparkles className="h-4 w-4" />}
                      label="Ambilight glow"
                      value={ambilight ? "On" : "Off"}
                      checked={ambilight}
                      onClick={onToggleAmbilight}
                    />
                  )}
                </>
              )}
            </>
          )}

          {tab === "playback" && (
            <>
              {onPickSpeed && (
                <>
                  <SectionLabel>Speed</SectionLabel>
                  <ChipRow>
                    {SPEED_PRESETS.map((rate) => (
                      <Chip
                        key={rate}
                        active={playbackSpeed === rate}
                        onClick={() => onPickSpeed(rate)}
                      >
                        {rate}×
                      </Chip>
                    ))}
                  </ChipRow>
                </>
              )}

              <SectionLabel>Behaviour</SectionLabel>
              {native && (
                <SettingRow
                  icon={<Repeat className="h-4 w-4" />}
                  label="Loop video"
                  value={loopOn ? "On" : "Off"}
                  checked={loopOn}
                  onClick={onToggleLoop}
                />
              )}
              {showAutoplayToggle && onToggleAutoplayNext && (
                <SettingRow
                  icon={<SkipForward className="h-4 w-4" />}
                  label="Autoplay next"
                  value={autoplayNext ? "On" : "Off"}
                  checked={autoplayNext}
                  onClick={onToggleAutoplayNext}
                />
              )}
              {audioBoost != null && onToggleBoost && native && (
                <SettingRow
                  icon={<AudioLines className="h-4 w-4" />}
                  label="Dialogue boost"
                  value={audioBoost ? "On" : "Off"}
                  checked={audioBoost}
                  onClick={onToggleBoost}
                />
              )}

              {showSleep && onPickSleep && (
                <>
                  <SectionLabel>Sleep timer</SectionLabel>
                  <p className="px-4 pb-1 pt-1 text-xs font-semibold text-white/50">
                    {sleepStatusLabel(sleepAfterEpisode, sleepUntil, now)}
                  </p>
                  <SleepOptionList
                    sleepAfterEpisode={sleepAfterEpisode}
                    sleepUntil={sleepUntil}
                    sleepMinutes={sleepMinutes}
                    onPick={(value) => onPickSleep(value)}
                  />
                </>
              )}

              <div className="flex items-center gap-3 px-4 pt-4 text-[11px] font-semibold text-white/35">
                <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                Picture and flip settings apply to this session only.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
