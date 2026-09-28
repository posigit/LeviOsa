"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Check, Plus } from "lucide-react";
import { useToast } from "@/components/toast";

/**
 * Show follow button. Small `compact` rows (search results) follow-only and
 * turn into a static check once followed — unfollowing deletes watched
 * history, so that stays on the show detail page menu. Poster corners carry
 * no control at all: tap the poster to open the show and add it there.
 */
export function ShowFollowButton({
  tmdbId,
  initialFollowing,
  variant = "full",
}: {
  tmdbId: number;
  initialFollowing: boolean;
  variant?: "compact" | "full";
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    // Compact: only add (unfollow is on detail page)
    if (variant === "compact" && following) {
      return;
    }

    const next = !following;
    const prev = following;
    setFollowing(next);
    try {
      navigator.vibrate?.(10);
    } catch {
      /* ignore */
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/show-follow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tmdbId, following: next }),
        });
        if (!res.ok) throw new Error("follow failed");
        toast(next ? "Added to watchlist" : "Removed from watchlist");
        router.refresh();
      } catch {
        setFollowing(prev);
        toast("Couldn't save — try again", "error");
      }
    });
  };

  // ----- compact: small round + / ✓ in search result rows -----
  if (variant === "compact") {
    if (following) {
      return (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-black">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        disabled={pending}
        aria-label="Add to watchlist"
        className="flex h-7 w-7 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={3} />
      </button>
    );
  }

  // ----- full -----
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className={cn(
        "w-full rounded-xl py-3 text-sm font-bold transition-colors disabled:opacity-50",
        following
          ? "bg-primary text-black"
          : "bg-card text-white hover:bg-secondary"
      )}
    >
      {following ? "✓ Following" : "Add to Watchlist"}
    </button>
  );
}
