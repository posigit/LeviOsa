"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Heart } from "lucide-react";
import { useToast } from "@/components/toast";

/**
 * Compact favorite toggle (round heart icon). Persists via /api/favorite.
 * Rendered only once the user has actually watched/consumed the title.
 * Liquid-glass circle; glows pink when active.
 */
export function FavoriteButton({
  mediaType,
  tmdbId,
  initialFavorite,
  className,
}: {
  mediaType: "movie" | "tv";
  tmdbId: number;
  initialFavorite: boolean;
  /** Sizing override — default is the compact 2.25rem circle. */
  className?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [favorite, setFavorite] = useState(initialFavorite);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !favorite;
    const prev = favorite;
    setFavorite(next);
    try {
      navigator.vibrate?.(10);
    } catch {
      /* ignore */
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/favorite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaType, tmdbId, favorite: next }),
        });
        if (!res.ok) throw new Error("favorite failed");
        toast(next ? "Added to favorites" : "Removed from favorites");
        router.refresh();
      } catch {
        setFavorite(prev);
        toast("Couldn't save — try again", "error");
      }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-xl transition-all active:scale-90 disabled:opacity-50",
        className,
        favorite
          ? "bg-pink-500/25 text-pink-400 ring-1 ring-pink-400/50 shadow-[0_8px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.3)]"
          : "bg-white/[0.12] text-white ring-1 ring-white/30 shadow-[0_8px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-white/25"
      )}
    >
      <Heart
        className="h-4 w-4"
        strokeWidth={favorite ? 2.5 : 2}
        fill={favorite ? "currentColor" : "none"}
      />
    </button>
  );
}