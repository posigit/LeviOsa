"use client";

import { useEffect } from "react";
import Image from "next/image";
import { Play, X } from "lucide-react";
import { stillUrl } from "@/lib/tmdb";

/**
 * Netflix-style up-next toast: small, bottom-right, subtle. A compact still
 * thumbnail + "Up next" + titles + circular countdown ring + linear progress
 * hairline. The whole card plays on tap, X cancels to the glass FAB.
 * Countdown ticks 10 → 1; 0 means autoplay is off (manual play).
 */
export function UpNextCard({
  episode,
  currentSeason,
  countdown,
  onPlay,
  onCancel,
  showTitle,
}: {
  episode: {
    title?: string;
    seasonNumber: number;
    episodeNumber: number;
    stillPath?: string | null;
  };
  currentSeason?: number;
  countdown: number;
  onPlay: () => void;
  onCancel: () => void;
  showTitle?: string;
}) {
  const still = stillUrl(episode.stillPath, "w185");
  // countdown > 0 → autoplay ring (10…1). 0 → manual play (autoplay off).
  const autoplay = countdown > 0;
  const progress = Math.max(0, Math.min(1, countdown / 10));
  const secondsLeft = Math.max(1, Math.ceil(countdown));
  const R = 15;
  const CIRC = 2 * Math.PI * R;
  const epLabel = `S${episode.seasonNumber}E${episode.episodeNumber}`;
  const epTitle = episode.title || epLabel;

  // Esc dismisses to the manual FAB — same as X.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-end justify-end gap-2 p-3 pb-4 sm:p-5">
      {/* Play surface — whole card is the play button */}
      <button
        type="button"
        onClick={onPlay}
        aria-label={
          autoplay
            ? `Play next: ${epTitle}, ${epLabel}, starting in ${secondsLeft} seconds`
            : `Play next: ${epTitle}, ${epLabel}`
        }
        className="animate-up-next-in pointer-events-auto relative flex w-80 max-w-[calc(100vw-4.5rem)] items-center gap-3 overflow-hidden rounded-2xl border border-white/15 bg-black/85 p-2.5 text-left shadow-2xl backdrop-blur-xl transition hover:border-white/25 hover:bg-black/90 active:scale-[0.99]"
      >
        {/* Title-accent hairline — matches the pause card's theme divider */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgb(var(--theme, 245 197 24) / 0.7), transparent)",
          }}
        />
        <div className="relative h-[68px] w-24 flex-shrink-0 overflow-hidden rounded-lg bg-[#2c2c2e]">
          {still ? (
            <Image
              src={still}
              alt=""
              fill
              sizes="96px"
              className="object-cover"
              decoding="async"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-white/40">
              <Play className="h-5 w-5 fill-current" />
            </div>
          )}
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-white">
            {epLabel}
          </span>
        </div>

        <div className="min-w-0 flex-1 py-0.5 pr-10">
          <p className="text-[10px] font-bold uppercase tracking-widest text-primary">
            {episode.seasonNumber > (currentSeason ?? 0)
              ? "Next season"
              : "Up next"}
          </p>
          {showTitle && (
            <p className="truncate text-[11px] font-medium text-white/50">
              {showTitle}
            </p>
          )}
          <p className="truncate text-sm font-semibold text-white">
            {epTitle}
          </p>
          <p
            className="mt-0.5 text-[11px] tabular-nums text-white/50"
            aria-live="polite"
          >
            {autoplay ? `Starts in ${secondsLeft}s` : "Autoplay off — tap to play"}
          </p>
        </div>

        {/* Circular countdown ring, or play glyph when autoplay is off */}
        <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
          {autoplay ? (
            <div className="relative" role="timer" aria-label={`${secondsLeft} seconds until next episode`}>
              <svg
                width="38"
                height="38"
                viewBox="0 0 38 38"
                className="-rotate-90"
                aria-hidden="true"
              >
                <circle
                  cx="19"
                  cy="19"
                  r={R}
                  fill="rgba(0,0,0,0.45)"
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth="3"
                />
                <circle
                  cx="19"
                  cy="19"
                  r={R}
                  fill="none"
                  style={{ stroke: "var(--primary)" }}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={CIRC * (1 - progress)}
                  className="transition-[stroke-dashoffset] duration-1000 ease-linear"
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xs font-bold tabular-nums text-white">
                {secondsLeft}
              </span>
            </div>
          ) : (
            <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-primary text-black">
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            </span>
          )}
        </div>

        {/* Linear countdown hairline */}
        {autoplay && (
          <div
            className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10"
            aria-hidden="true"
          >
            <div
              className="h-full bg-primary transition-[width] duration-1000 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}
      </button>

      {/* Cancel — separate 32px hit area, never nested in the play button */}
      <button
        type="button"
        onClick={onCancel}
        aria-label="Don't autoplay — show play button instead"
        className="pointer-events-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white/70 shadow-lg backdrop-blur transition hover:bg-black/90 hover:text-white active:scale-95"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
