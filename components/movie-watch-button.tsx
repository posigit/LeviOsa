"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Check, Plus } from "lucide-react";
import { useToast } from "@/components/toast";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";

export type MovieStatus = "want_to_watch" | "watched" | null;

/**
 * Movie library actions.
 *
 * Semantics (fixed): "Want to Watch" adds to the watchlist
 * (status = want_to_watch) — it never marks a movie watched.
 * Small surfaces (overlay/compact) are add-to-watchlist only and turn into a
 * static check once the movie is in the library; the full watch/unwatch and
 * remove controls live on the movie detail page (variant="full").
 */
export function MovieWatchButton({
  tmdbId,
  initialStatus,
  variant = "full",
}: {
  tmdbId: number;
  initialStatus: string | null;
  variant?: "overlay" | "compact" | "full";
}) {
  const router = useRouter();
  const { toast } = useToast();
  // Tolerate legacy statuses (e.g. for_later): any non-null value = in library
  const normalize = (s: string | null): MovieStatus =>
    s === "watched" ? "watched" : s ? "want_to_watch" : null;
  const [status, setStatus] = useState<MovieStatus>(() =>
    normalize(initialStatus)
  );
  const [pending, startTransition] = useTransition();

  const update = (next: MovieStatus) => {
    const prev = status;
    // Optimistic flip
    setStatus(next);
    try {
      navigator.vibrate?.(10);
    } catch {
      /* ignore */
    }
    startTransition(async () => {
      try {
        const res = await postJsonOffline("/api/movie-watch", {
          tmdbId,
          status: next,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error("save failed");
        if (queuedOffline(res)) {
          toast("Saved offline — will sync", "info");
        }
        // Re-adding a watched title queues a rewatch (stays watched underneath).
        else if (data?.queuedRewatch) {
          setStatus("watched");
          toast("Queued for rewatch — in Watch Next");
        } else if (next === "watched") toast("Marked watched");
        else if (next === "want_to_watch") toast("Added to watchlist");
        else if (prev === "watched") toast("Marked unwatched", "info");
        else toast("Removed from My List", "info");
        router.refresh();
      } catch {
        setStatus(prev);
        toast("Couldn't save — try again", "error");
      }
    });
  };

  // ----- overlay: round + / ✓ on poster corners (explore grids) -----
  if (variant === "overlay") {
    if (status) {
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-black shadow">
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      );
    }
    return (
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          update("want_to_watch");
        }}
        disabled={pending}
        aria-label="Add to watchlist"
        className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white shadow backdrop-blur-sm transition-colors hover:bg-black/80"
      >
        <Plus className="h-4 w-4" strokeWidth={3} />
      </button>
    );
  }

  // ----- compact: small round + / ✓ in search result rows -----
  if (variant === "compact") {
    if (status) {
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-black">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      );
    }
    return (
      <button
        onClick={() => update("want_to_watch")}
        disabled={pending}
        aria-label="Add to watchlist"
        className="flex h-7 w-7 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-secondary"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={3} />
      </button>
    );
  }

  // ----- full: detail page state controls stay secondary to playback -----
  // Active states pick up the page theme (--theme set by detail pages).
  const inMyList = status === "want_to_watch";
  const watched = status === "watched";
  return (
    <div className="flex items-start gap-5 px-1">
      <button
        onClick={() => update(inMyList ? null : "want_to_watch")}
        disabled={pending}
        aria-label={inMyList ? "Remove from My List" : "Add to My List"}
        aria-pressed={inMyList}
        title={inMyList ? "In My List" : "Add to My List"}
        className="group flex min-w-[3.25rem] flex-col items-center gap-1"
      >
        <span
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-xl transition group-active:scale-[0.94]",
            inMyList
              ? "bg-[rgb(var(--theme)/0.9)] text-white ring-1 ring-white/40 shadow-[0_8px_24px_rgb(var(--theme)/0.55),inset_0_1px_0_rgba(255,255,255,0.45)]"
              : "bg-white/[0.1] text-white/80 ring-1 ring-white/25 shadow-[0_8px_24px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-white/20 hover:text-white"
          )}
        >
          {inMyList ? (
            <Check className="h-4 w-4" strokeWidth={3} />
          ) : (
            <Plus className="h-4 w-4" strokeWidth={3} />
          )}
        </span>
        <span className="text-[10px] font-semibold text-white/45">
          {inMyList ? "In list" : "My list"}
        </span>
      </button>
      <button
        onClick={() => update(watched ? null : "watched")}
        disabled={pending}
        aria-label={watched ? "Mark unwatched" : "Mark watched"}
        aria-pressed={watched}
        title={watched ? "Watched — tap to mark unwatched" : "Mark watched"}
        className="group flex min-w-[3.25rem] flex-col items-center gap-1"
      >
        <span
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-xl transition group-active:scale-[0.94]",
            watched
              ? "bg-[rgb(var(--theme)/0.9)] text-white ring-1 ring-white/40 shadow-[0_8px_24px_rgb(var(--theme)/0.55),inset_0_1px_0_rgba(255,255,255,0.45)]"
              : "bg-white/[0.1] text-white/80 ring-1 ring-white/25 shadow-[0_8px_24px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-white/20 hover:text-white"
          )}
        >
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
        <span className="text-[10px] font-semibold text-white/45">
          {watched ? "Watched" : "Mark watched"}
        </span>
      </button>
    </div>
  );
}
