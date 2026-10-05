import { useEffect, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, LoaderCircle, Lock } from "lucide-react";

type UnlockButtonProps = {
  onUnlock: () => void;
};

export function UnlockButton({ onUnlock }: UnlockButtonProps) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      aria-label="Unlock player controls"
      className="absolute right-4 top-4 z-40 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
    >
      <Lock className="h-5 w-5" />
    </button>
  );
}

type TapCueProps = {
  side: "left" | "right";
};

export function TapCue({ side }: TapCueProps) {
  const right = side === "right";
  return (
    <div
      role="status"
      aria-label={
        right ? "Skipped forward 10 seconds" : "Skipped back 10 seconds"
      }
      className={`pointer-events-none absolute inset-y-0 z-40 flex items-center ${
        right ? "justify-end pr-4 sm:pr-8" : "justify-start pl-4 sm:pl-8"
      }`}
    >
      <span className="player-skip flex items-center gap-1.5 rounded-full bg-black/75 py-2 pl-3.5 pr-4 text-sm font-black tabular-nums text-white ring-1 ring-white/20 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.9)] backdrop-blur">
        {right ? (
          <>
            <ChevronRight className="h-4 w-4 text-primary" aria-hidden="true" />
            <span>10s</span>
          </>
        ) : (
          <>
            <ChevronLeft className="h-4 w-4 text-primary" aria-hidden="true" />
            <span>10s</span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Rotating player tips — every one of these is a shipped feature (see the
 * keyboard handler, gesture layer, top chrome and transport in vix-player /
 * player-top-chrome / player-transport). Rotates every 8s, deterministic start
 * (no hydration noise) and no live region, so a screen reader never gets a
 * running commentary.
 */
export const PLAYER_TIPS = [
  "Double-tap the left or right side to jump 10 seconds.",
  "Swipe on the left half for brightness, the right half for volume.",
  "F is fullscreen, K plays/pauses, M mutes, Z fits or crops.",
  "Arrows (or J / L) skip 10 seconds.",
  "The scrubber paints skip-intro and credits segments — drag between them.",
  "Set a sleep timer and playback stops when you drift off.",
  "Dialogue boost lifts quiet voices without loud explosions.",
  "Ambilight tints the screen with the colour of the scene.",
  "Cast to a TV, or download for offline — both live in the top bar.",
  "Style subtitles: size, colour, background and blur.",
  "Lock hides every control until you unlock it.",
];

export function TipLine({
  className = "",
  accent,
  intervalMs = 8000,
}: {
  className?: string;
  /** Optional CSS colour (per-title accent) for the "Tip" label. */
  accent?: string;
  intervalMs?: number;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((i) => (i + 1) % PLAYER_TIPS.length),
      intervalMs
    );
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return (
    <p className={className}>
      <span
        className={`font-black uppercase tracking-[0.3em] ${
          accent ? "" : "text-primary/70"
        }`}
        style={accent ? { color: accent } : undefined}
      >
        Tip
      </span>{" "}
      <span className="text-white/55">{PLAYER_TIPS[index]}</span>
    </p>
  );
}

/**
 * Loading splash: black frame, brand mark, a scan-line sweeping down the
 * picture and the status label with a blinking caret — replaces the old
 * centred pill while a source resolves or a native stream boots.
 *
 * Interference contract (this is what makes it safe to put over everything):
 * `pointer-events-none`, `z-[5]` (error card z-6, resume prompt z-7, chrome
 * z-30+), mounted only while the player reports `isLoading`, and decorative
 * layers are `aria-hidden` — only the status line is a live region.
 */
export function LoadingSplash({
  label,
  eyebrow = "Loading",
}: {
  label: string;
  eyebrow?: string;
}) {
  return (
    <div className="player-splash pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-5 overflow-hidden bg-black px-6 text-center">
      <div aria-hidden="true" className="player-scan" />

      <div
        aria-hidden="true"
        className="splash-mark relative"
        style={{ width: "min(30vw, 132px)" }}
      >
        <div className="splash-glow" />
        <Image
          className="splash-logo"
          src="/icons/icon-512x512.png?v=14"
          alt=""
          width={132}
          height={132}
          priority
          unoptimized
          style={{ width: "100%", height: "auto" }}
        />
        <div className="splash-shine" />
      </div>

      <div className="relative z-[1]">
        <p className="text-[10px] font-black uppercase tracking-[0.45em] text-white/45">
          {eyebrow}
        </p>
        <p
          role="status"
          aria-live="polite"
          className="mt-2 max-w-[min(24rem,80vw)] text-sm font-semibold text-white/85"
        >
          {label}
          <span aria-hidden="true" className="player-caret">
            _
          </span>
        </p>
        <TipLine className="mx-auto mt-4 max-w-[min(26rem,86vw)] text-[11px] leading-relaxed" />
      </div>

      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-white/[0.06]"
      >
        <div className="player-shimmer h-full w-1/3 bg-gradient-to-r from-transparent via-[var(--primary-soft)] to-transparent" />
      </div>
    </div>
  );
}

/**
 * Rebuffer spinner only once playback has started — centered above the
 * picture, never over the Play control (it sits at z-30 vs the transport's
 * z-20, so a spinner while paused would swallow the tap).
 */
export function BufferingSpinner() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60 backdrop-blur">
        <LoaderCircle className="h-5 w-5 animate-spin text-white/85" />
      </span>
    </div>
  );
}

/** Optional catalogue facts for the pause card — hosts that have them pass
 *  them; hosts without them still get the card (title + "Paused" only). */
export type PausedInfo = {
  overview?: string | null;
  /** Release year (movie release year / show first-air year). */
  year?: number | null;
  /** Runtime in minutes (episode runtime preferred over series average). */
  runtime?: number | null;
  /** TMDB vote average, 0–10. */
  rating?: number | null;
  genres?: string[];
  /** One-line hook printed italic under the title. */
  tagline?: string | null;
};

function runtimeLabel(minutes?: number | null): string | null {
  if (!Number.isFinite(minutes ?? NaN) || (minutes ?? 0) <= 0) return null;
  const total = Math.round(minutes as number);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Hosts pack a TV title as "Show — S3E23 Episode"; the pause card wants them
 * stacked (big show name, episode line beneath). Movies never split — a movie
 * title may legitimately contain an em dash.
 */
export function splitPauseTitle(
  title: string,
  type?: "movie" | "tv"
): { title: string; subtitle: string | null } {
  if (type !== "tv") return { title, subtitle: null };
  const dash = title.indexOf(" \u2014 ");
  if (dash <= 0) return { title, subtitle: null };
  return { title: title.slice(0, dash), subtitle: title.slice(dash + 3) };
}

/**
 * Pause card. Renders under the chrome (z-4, transport is z-30) and only once
 * the chrome has auto-hided, so it never fights the controls for the same
 * pixels — tap anywhere to bring the controls straight back.
 *
 * Mirrors VidStuck's card: a full-frame dim (bg-black/70 + 2px blur) behind a
 * left-anchored, vertically centred stack — eyebrow → handwritten title →
 * episode → tagline → meta → chips → short rule → description → tip. Faces
 * match theirs exactly: Permanent Marker 400 on the title (.pause-title),
 * Lexend 400 on everything else (.pause-body on the wrapper). `select-none`
 * so a long-press can't half-select the copy, `pointer-events-none` so taps
 * keep falling through to the video (tap-to-show-chrome) and Up Next.
 */
export function PausedInfoLayer({
  title,
  subtitle,
  info,
}: {
  title: string;
  /** Episode line under the title, e.g. "S3 E23 Deus Ex Machina". */
  subtitle?: string | null;
  info?: PausedInfo | null;
}) {
  // Let the chrome leave first, then fade in (VidStuck-style, ~1 beat).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setShown(true), 260);
    return () => window.clearTimeout(id);
  }, []);

  const meta = [
    info?.year ? String(info.year) : null,
    runtimeLabel(info?.runtime),
    info?.rating != null && info.rating > 0
      ? `★ ${info.rating.toFixed(1)}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  const genres = (info?.genres ?? []).filter(Boolean).slice(0, 4);
  const overview = info?.overview?.trim() || null;
  const tagline = info?.tagline?.trim() || null;
  // Per-title accent: detail pages publish their colour as --theme (an RGB
  // triplet). Hosts without one (home, continue-watching, history) fall back to
  // the app's default gold, so the card can never land on an invisible colour.
  const accent = "rgb(var(--theme, 245 197 24) / 0.95)";

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[4] flex select-none items-center ${
        shown ? "opacity-100" : "opacity-0"
      } transition-opacity duration-500 motion-reduce:transition-none`}
    >
      {/* Uniform dim + a hair of blur — the same backdrop VidStuck uses, so
          the copy reads over any frame without guessing where the action is. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
      />

      <div className="pause-body relative w-full max-w-3xl px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:px-16">
        <p
          role="status"
          className="pause-eyebrow mb-3 flex items-center gap-3 text-sm font-medium uppercase tracking-widest text-white/60 md:mb-5"
        >
          Paused
        </p>

        <h2 className="pause-title break-words text-4xl leading-tight text-white [text-shadow:0_2px_20px_rgba(0,0,0,0.75)] md:text-6xl">
          {title}
        </h2>

        {subtitle && (
          <p className="pause-subtitle mt-1.5 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:text-sm">
            {subtitle}
          </p>
        )}

        {tagline && (
          <p className="pause-tagline mt-2 text-sm italic text-white/60 md:text-base">
            {tagline}
          </p>
        )}

        {meta.length > 0 && (
          <p className="pause-meta mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums text-white/70 md:mt-4">
            {meta.map((entry, i) => (
              <span key={entry} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span aria-hidden="true" className="text-white/30">
                    •
                  </span>
                )}
                {entry}
              </span>
            ))}
          </p>
        )}

        {genres.length > 0 && (
          <div className="pause-chips mt-4 flex flex-wrap gap-2">
            {genres.map((genre) => (
              <span
                key={genre}
                className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70"
              >
                {genre}
              </span>
            ))}
          </div>
        )}

        {overview && (
          <>
            <div aria-hidden="true" className="pause-rule mt-6 h-px w-16 bg-white/40" />
            <p className="pause-overview mt-3 line-clamp-3 max-w-2xl break-words text-sm leading-6 text-white/65 md:mt-5 md:text-base">
              {overview}
            </p>
          </>
        )}

        <TipLine
          accent={accent}
          className="pause-tip mt-4 max-w-2xl border-t border-white/10 pt-3 text-[11px] leading-relaxed md:text-xs"
        />
      </div>
    </div>
  );
}
