"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { VixPlayer } from "@/components/vix-player";
import { vixMovieUrl } from "@/lib/vixsrc";
import { useToast } from "@/components/toast";
import type { PlaybackSummary } from "@/lib/playback";
import { formatPlaybackTime } from "@/lib/playback-format";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";
import { cn } from "@/lib/utils";

/**
 * Primary play pill for movies — opens the VixSrc player. Same liquid-glass
 * shape as the show hero CTA (Watch / Resume / Rewatch).
 * Auto-marks the movie watched when playback ends; finishing an already
 * watched title logs a rewatch stamp instead.
 */
export function MovieVixButton({
  tmdbId,
  title,
  isWatched,
  isRewatchQueued,
  playback,
  className,
}: {
  tmdbId: number;
  title: string;
  isWatched: boolean;
  isRewatchQueued?: boolean;
  playback?: PlaybackSummary | null;
  /** Extra classes for the pill row (the detail page drives the flex shape). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const completionRef = useRef(false);
  const router = useRouter();
  const { toast } = useToast();

  if (!open) {
    const timeLeft = playback ? formatPlaybackTime(playback.timeLeftSeconds) : null;
    const label = timeLeft
      ? `Resume · ${timeLeft} left`
      : isWatched
        ? "Rewatch"
        : "Watch";
    return (
      <button
        type="button"
        onClick={() => {
          completionRef.current = false;
          setOpen(true);
        }}
        className={cn(
          "glass-control flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 text-[15px] font-bold text-white transition hover:bg-white/[0.18] active:scale-[0.98]",
          className
        )}
      >
        <Play className="h-4 w-4 shrink-0 fill-white" />
        <span className="truncate">{label}</span>
      </button>
    );
  }

  const handleEvent = async (event: string) => {
    if (event !== "ended") return;
    if (completionRef.current) return;
    completionRef.current = true;
    try {
      // Finishing an already-watched title = a rewatch. Stamp history and
      // clear the queue flag so Watch Next drops it.
      const res = isWatched
        ? await postJsonOffline("/api/movie-rewatch", { tmdbId, mode: "log" })
        : await postJsonOffline("/api/movie-watch", {
            tmdbId,
            status: "watched",
          });
      if (!res.ok) throw new Error("save failed");
      if (queuedOffline(res)) {
        toast("Watched — saved offline", "info");
      } else if (isWatched) {
        toast(
          isRewatchQueued ? "Rewatch logged — nice one!" : "Rewatch logged!"
        );
      } else {
        toast("Watched — nice one!");
      }
      router.refresh();
    } catch {
      completionRef.current = false;
      toast("Couldn't mark watched", "error");
    }
  };

  return (
    <VixPlayer
      src={vixMovieUrl(tmdbId)}
      type="movie"
      tmdbId={tmdbId}
      title={title}
      initialPosition={playback?.positionSeconds}
      autoResume={Boolean(playback)}
      onEvent={handleEvent}
      onClose={() => {
        setOpen(false);
        // Re-fetch playback server state so the CTA reflects saved progress.
        router.refresh();
      }}
    />
  );
}
