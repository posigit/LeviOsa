"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { formatEpisodeLabel, useToast } from "@/components/toast";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";

/** White filled circle check button (snapshot 1/2 style) — optimistic */
export function MarkWatchedButton({
  showTmdbId,
  seasonNumber,
  episodeNumber,
  onWatched,
  onWatchFailed,
}: {
  showTmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** Fired on optimistic flip so parent can dismiss the row immediately */
  onWatched?: () => void;
  /** Fired if the network save fails so parent can restore the row */
  onWatchFailed?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (done || pending) return;

    // Optimistic: flip immediately
    setDone(true);
    setPending(true);
    onWatched?.();
    try {
      navigator.vibrate?.(10);
    } catch {
      /* ignore */
    }

    try {
      const res = await postJsonOffline("/api/watch", {
        showTmdbId,
        seasonNumber,
        episodeNumber,
        watched: true,
      });
      if (!res.ok) throw new Error("watch failed");

      const label = formatEpisodeLabel(seasonNumber, episodeNumber);
      toast(
        queuedOffline(res) ? `Watched ${label} — saved offline` : `Watched ${label}`
      );
      // Soft refresh — UI already updated; keep list in sync with server
      router.refresh();
    } catch {
      setDone(false);
      onWatchFailed?.();
      toast("Couldn't save — try again", "error");
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={done || pending}
      className={cn(
        "flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-all active:scale-90",
        done
          ? "bg-primary text-black scale-95"
          : "bg-white text-black",
        pending && !done && "opacity-60"
      )}
      aria-label={done ? "Watched" : "Mark as watched"}
      aria-pressed={done}
    >
      <Check className="h-5 w-5" strokeWidth={3} />
    </button>
  );
}
