"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Star } from "lucide-react";

/**
 * Ratings are stored as integers 1-10 and displayed as 0.5-5 stars
 * (stored value = stars x 2), so half stars are integers: 7 = 3.5 stars.
 */

const RATING_LABELS: Record<number, string> = {
  1: "Trash",
  2: "Bad",
  3: "Weak",
  4: "Meh",
  5: "Okay",
  6: "Decent",
  7: "Good",
  8: "Great",
  9: "Superb",
  10: "Masterpiece",
};

function StarGlyph({
  fill,
  size,
}: {
  fill: "full" | "half" | "empty";
  size: number;
}) {
  return (
    <span
      className="relative inline-block flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <Star
        className="absolute inset-0 text-white/20"
        style={{ width: size, height: size }}
        strokeWidth={1.75}
        fill="rgba(255,255,255,0.06)"
      />
      {fill !== "empty" && (
        <span
          className="absolute inset-0 overflow-hidden"
          style={{ width: fill === "half" ? size / 2 : size }}
        >
          <Star
            className="text-primary drop-shadow-[0_0_6px_var(--primary-soft)]"
            fill="currentColor"
            style={{ width: size, height: size }}
            strokeWidth={1.5}
          />
        </span>
      )}
    </span>
  );
}

/** Read-only 5-star display for a stored 1-10 rating. */
export function StarRatingDisplay({
  value,
  size = 14,
  className,
}: {
  value: number;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <StarGlyph
          key={i}
          size={size}
          fill={value >= i * 2 ? "full" : value >= i * 2 - 1 ? "half" : "empty"}
        />
      ))}
    </span>
  );
}

/**
 * Interactive 5-star picker with half-star steps.
 * Tap the left half of a star for x.5, the right half for the full star.
 * Tapping the current value again clears the rating (null).
 */
export function StarRatingInput({
  value,
  onChange,
  size = 34,
  disabled,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Your rating">
      {[1, 2, 3, 4, 5].map((i) => {
        const filled = (value ?? 0) >= i * 2 - 1;
        return (
          <span
            key={i}
            className={cn(
              "relative inline-block transition-transform",
              filled && "scale-105"
            )}
            style={{ width: size, height: size }}
          >
            <StarGlyph
              size={size}
              fill={
                (value ?? 0) >= i * 2
                  ? "full"
                  : (value ?? 0) >= i * 2 - 1
                    ? "half"
                    : "empty"
              }
            />
            <button
              type="button"
              disabled={disabled}
              aria-label={`${i - 0.5} stars`}
              onClick={() => {
                try {
                  navigator.vibrate?.(8);
                } catch {
                  /* ignore */
                }
                onChange(value === i * 2 - 1 ? null : i * 2 - 1);
              }}
              className="absolute left-0 top-0 h-full w-1/2 rounded-l-full transition active:scale-90"
            />
            <button
              type="button"
              disabled={disabled}
              aria-label={`${i} stars`}
              onClick={() => {
                try {
                  navigator.vibrate?.(8);
                } catch {
                  /* ignore */
                }
                onChange(value === i * 2 ? null : i * 2);
              }}
              className="absolute right-0 top-0 h-full w-1/2 rounded-r-full transition active:scale-90"
            />
          </span>
        );
      })}
    </div>
  );
}

/** Small poster-corner badge: ★ 4.5 */
export function RatingBadge({ value }: { value: number }) {
  return (
    <span className="absolute bottom-1 left-1 z-10 flex items-center gap-0.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-primary backdrop-blur-sm">
      <Star className="h-2.5 w-2.5" fill="currentColor" />
      {(value / 2).toFixed(1)}
    </span>
  );
}

function formatStars(value: number): string {
  return (value / 2).toFixed(1);
}

/** Connected movie rating — only rendered after Mark Watched. */
export function MovieRating({
  tmdbId,
  initialRating,
}: {
  tmdbId: number;
  initialRating: number | null;
}) {
  const [rating, setRating] = useState(initialRating);
  const [pending, startTransition] = useTransition();

  const save = (next: number | null) => {
    const prev = rating;
    setRating(next);
    startTransition(async () => {
      try {
        const res = await fetch("/api/rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "movie", tmdbId, rating: next }),
        });
        if (!res.ok) throw new Error("rate failed");
      } catch {
        setRating(prev);
      }
    });
  };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Your rating
        </p>
        {rating != null && (
          <p className="text-[11px] font-bold uppercase tracking-wide text-primary">
            {RATING_LABELS[rating] ?? ""}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <StarRatingInput value={rating} onChange={save} disabled={pending} />
        {rating != null && (
          <span className="min-w-[3rem] text-center text-lg font-black tabular-nums text-primary">
            {formatStars(rating)}
          </span>
        )}
      </div>
      {rating != null && (
        <button
          type="button"
          onClick={() => save(null)}
          disabled={pending}
          className="mt-1.5 px-1 text-[11px] font-semibold text-white/40 underline-offset-2 hover:text-white/70 hover:underline disabled:opacity-50"
        >
          Clear rating
        </button>
      )}
    </div>
  );
}

/** Connected episode rating chip + popover picker (watched episodes only). */
export function EpisodeRating({
  showTmdbId,
  seasonNumber,
  episodeNumber,
  initialRating,
}: {
  showTmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  initialRating: number | null;
}) {
  const [rating, setRating] = useState(initialRating);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = (next: number | null) => {
    const prev = rating;
    setRating(next);
    setOpen(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "episode",
            showTmdbId,
            seasonNumber,
            episodeNumber,
            rating: next,
          }),
        });
        if (!res.ok) throw new Error("rate failed");
      } catch {
        setRating(prev);
      }
    });
  };

  return (
    <div className="relative mt-1 inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 rounded-full border border-white/15 px-2 py-1 transition-colors hover:bg-secondary"
        aria-label={rating != null ? `Your rating: ${formatStars(rating)}` : "Rate episode"}
      >
        <Star
          className="h-3 w-3 text-primary"
          fill={rating != null ? "currentColor" : "none"}
        />
        <span className="text-[11px] font-semibold text-white/80">
          {rating != null ? formatStars(rating) : "Rate"}
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-30 rounded-xl border border-white/10 bg-[#1c1c1e] p-2.5 shadow-xl">
          <StarRatingInput
            size={30}
            value={rating}
            onChange={save}
            disabled={pending}
          />
          {rating != null && (
            <p className="mt-1 text-center text-[11px] font-bold text-primary">
              {formatStars(rating)} · {RATING_LABELS[rating] ?? ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
