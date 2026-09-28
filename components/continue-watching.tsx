"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { posterUrl } from "@/lib/tmdb";
import { vixMovieUrl, vixTvUrl } from "@/lib/vixsrc";
import { VixPlayer } from "@/components/vix-player";
import type { ContinueWatchingItem } from "@/lib/playback";
import { formatEpisodeCode, formatPlaybackTime } from "@/lib/playback-format";
import { useToast } from "@/components/toast";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";

function ResumeCard({ item }: { item: ContinueWatchingItem }) {
  const [open, setOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const poster = posterUrl(item.posterPath, "w342");
  const episodeCode =
    item.mediaType === "tv"
      ? formatEpisodeCode(item.seasonNumber, item.episodeNumber)
      : null;
  const timeLeft = formatPlaybackTime(item.timeLeftSeconds);
  const title =
    item.mediaType === "tv" && item.episodeTitle
      ? `${item.title} — ${episodeCode} ${item.episodeTitle}`
      : item.title;
  const src =
    item.mediaType === "tv"
      ? vixTvUrl(item.tmdbId, item.seasonNumber, item.episodeNumber)
      : vixMovieUrl(item.tmdbId);

  if (open) {
    return (
      <VixPlayer
        src={src}
        type={item.mediaType}
        tmdbId={item.tmdbId}
        season={item.mediaType === "tv" ? item.seasonNumber : undefined}
        episode={item.mediaType === "tv" ? item.episodeNumber : undefined}
        title={title}
        initialPosition={item.positionSeconds}
        autoResume
        onEvent={async (event) => {
          if (event !== "ended" || completed) return;
          setCompleted(true);
          try {
            const response =
              item.mediaType === "movie"
                ? await postJsonOffline("/api/movie-watch", {
                    tmdbId: item.tmdbId,
                    status: "watched",
                  })
                : await postJsonOffline("/api/watch", {
                    showTmdbId: item.tmdbId,
                    seasonNumber: item.seasonNumber,
                    episodeNumber: item.episodeNumber,
                    watched: true,
                  });
            if (!response.ok) throw new Error("completion failed");
            toast(
              queuedOffline(response)
                ? "Saved offline — will sync"
                : "Saved as watched"
            );
          } catch {
            setCompleted(false);
            toast("Couldn’t save watched status", "error");
          }
        }}
        onClose={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="group w-[11.5rem] shrink-0 overflow-hidden rounded-xl bg-card text-left ring-1 ring-border transition hover:ring-primary/60 active:scale-[0.98]"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-secondary">
        {poster ? (
          <Image
            src={poster}
            alt={item.title}
            fill
            sizes="184px"
            className="object-cover transition duration-300 group-hover:scale-105"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
            {item.title}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/10" />
        <span className="absolute bottom-2 left-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-black shadow-lg">
          <Play className="h-4 w-4 fill-current" />
        </span>
        {item.progressPercent != null && (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-foreground/20">
            <span
              className="block h-full bg-primary"
              style={{ width: `${item.progressPercent}%` }}
            />
          </span>
        )}
      </div>
      <div className="p-2.5">
        <p className="truncate text-sm font-bold text-foreground">{item.title}</p>
        <p className="mt-0.5 truncate text-[11px] font-semibold text-muted-foreground">
          {episodeCode ? `${episodeCode}${item.episodeTitle ? ` · ${item.episodeTitle}` : ""}` : "Movie"}
        </p>
        <p className="mt-2 text-xs font-black text-primary">
          Resume{timeLeft ? ` · ${timeLeft} left` : ""}
        </p>
      </div>
    </button>
  );
}

export function ContinueWatchingRail({
  items,
  className = "",
}: {
  items: ContinueWatchingItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className={`mb-7 ${className}`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">
            Pick up where you left off
          </p>
          <h2 className="mt-1 text-xl font-black text-foreground">Continue watching</h2>
        </div>
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <ResumeCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}
