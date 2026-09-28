"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Play, X } from "lucide-react";
import { posterUrl } from "@/lib/tmdb";
import { formatAppDateShort } from "@/lib/app-time";
import { vixMovieUrl, vixTvUrl } from "@/lib/vixsrc";
import { VixPlayer } from "@/components/vix-player";
import type { ContinueWatchingItem, WatchHistoryItem } from "@/lib/playback";
import { formatEpisodeCode, formatPlaybackTime } from "@/lib/playback-format";
import { useToast } from "@/components/toast";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";

function itemLabel(item: WatchHistoryItem) {
  if (item.mediaType !== "tv") return "Movie";
  const code = formatEpisodeCode(item.seasonNumber, item.episodeNumber);
  return `${code}${item.episodeTitle ? ` · ${item.episodeTitle}` : ""}`;
}

function playerTitle(item: WatchHistoryItem) {
  return item.mediaType === "tv" && item.episodeTitle
    ? `${item.title} — ${itemLabel(item)}`
    : item.title;
}

function playbackQuery(item: WatchHistoryItem) {
  const params = new URLSearchParams({
    type: item.mediaType,
    id: String(item.tmdbId),
  });
  if (item.mediaType === "tv") {
    params.set("season", String(item.seasonNumber));
    params.set("episode", String(item.episodeNumber));
  }
  return params.toString();
}

async function markComplete(item: WatchHistoryItem) {
  if (item.mediaType === "movie") {
    return postJsonOffline("/api/movie-watch", {
      tmdbId: item.tmdbId,
      status: "watched",
    });
  }
  return postJsonOffline("/api/watch", {
    showTmdbId: item.tmdbId,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    watched: true,
  });
}

function StreamPlayer({
  item,
  onClose,
}: {
  item: WatchHistoryItem;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [completed, setCompleted] = useState(false);
  const src =
    item.mediaType === "tv"
      ? vixTvUrl(item.tmdbId, item.seasonNumber, item.episodeNumber)
      : vixMovieUrl(item.tmdbId);

  const handleEvent = async (event: string) => {
    if (event !== "ended" || completed) return;
    setCompleted(true);
    try {
      const response = await markComplete(item);
      if (!response.ok) throw new Error("completion failed");
      toast(
        queuedOffline(response) ? "Saved offline — will sync" : "Saved as watched"
      );
    } catch {
      setCompleted(false);
      toast("Couldn’t save watched status", "error");
    }
  };

  return (
    <VixPlayer
      src={src}
      type={item.mediaType}
      tmdbId={item.tmdbId}
      season={item.mediaType === "tv" ? item.seasonNumber : undefined}
      episode={item.mediaType === "tv" ? item.episodeNumber : undefined}
      title={playerTitle(item)}
      initialPosition={item.positionSeconds ?? undefined}
      autoResume={item.positionSeconds != null}
      onEvent={handleEvent}
      onClose={() => {
        onClose();
        router.refresh();
      }}
    />
  );
}

function ProfileStreamTile({
  item,
  onDismiss,
  dismissing = false,
}: {
  item: WatchHistoryItem;
  onDismiss?: () => void;
  dismissing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const poster = posterUrl(item.posterPath, "w342");
  const timeLeft = formatPlaybackTime(item.timeLeftSeconds);
  const isInProgress = item.positionSeconds != null && item.positionSeconds > 0;

  if (open) {
    return <StreamPlayer item={item} onClose={() => setOpen(false)} />;
  }

  return (
    <div className="group/card relative w-[15rem] shrink-0 overflow-hidden rounded-[1.1rem] bg-card text-left ring-1 ring-border transition hover:ring-border">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group block w-full text-left active:scale-[0.98]"
      >
      <div className="relative h-[8.5rem] overflow-hidden bg-secondary">
        {poster ? (
          <Image
            src={poster}
            alt={item.title}
            fill
            sizes="240px"
            className="object-cover transition duration-300 group-hover:scale-105"
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
            {item.title}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-transparent" />
        <span className="absolute bottom-3 left-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-black shadow-lg transition group-hover:scale-105">
          <Play className="h-4 w-4 fill-current" />
        </span>
        {item.progressPercent != null && (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
            <span
              className="block h-full bg-primary"
              style={{ width: `${item.progressPercent}%` }}
            />
          </span>
        )}
      </div>
      <div className="px-3.5 pb-3.5 pt-3">
        <p className="truncate text-[15px] font-bold tracking-[-0.01em] text-foreground">
          {item.title}
        </p>
        <p className="mt-1 truncate text-xs font-medium text-foreground/45">
          {itemLabel(item)}
        </p>
        <p className="mt-3 text-sm font-bold text-primary">
          {isInProgress
            ? timeLeft
              ? `Resume · ${timeLeft} left`
              : "Resume"
            : `Played ${formatAppDateShort(item.watchedAt.slice(0, 10))}`}
        </p>
      </div>
      </button>
      {isInProgress && onDismiss && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          disabled={dismissing}
          aria-label="Remove from Continue watching"
          title="Remove from Continue watching"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white/80 ring-1 ring-white/20 backdrop-blur transition hover:bg-black/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-50 md:opacity-0 md:group-hover/card:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function StreamRow({ item }: { item: WatchHistoryItem }) {
  const [open, setOpen] = useState(false);
  const poster = posterUrl(item.posterPath, "w185");
  const timeLeft = formatPlaybackTime(item.timeLeftSeconds);

  if (open) {
    return <StreamPlayer item={item} onClose={() => setOpen(false)} />;
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex w-full items-center gap-3 rounded-xl bg-card p-2.5 text-left transition hover:bg-secondary active:scale-[0.99]"
    >
      <div className="relative h-[66px] w-[44px] flex-shrink-0 overflow-hidden rounded-md bg-secondary">
        {poster ? (
          <Image
            src={poster}
            alt={item.title}
            fill
            sizes="44px"
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-1 text-center text-[8px] text-muted-foreground">
            {item.title}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-foreground">{item.title}</p>
        <p className="mt-0.5 truncate text-xs font-semibold text-muted-foreground">
          {itemLabel(item)}
        </p>
        <p className="mt-1 text-[11px] font-black text-primary">
          {timeLeft ? `Resume · ${timeLeft} left` : "Play again"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className="text-[10px] font-bold text-muted-foreground">
          {formatAppDateShort(item.watchedAt.slice(0, 10))}
        </span>
        <Play className="h-4 w-4 fill-current text-primary" />
      </div>
    </button>
  );
}

function toHistoryItem(item: ContinueWatchingItem): WatchHistoryItem {
  return {
    id: `playback-${item.key}`,
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    title: item.title,
    posterPath: item.posterPath,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    episodeTitle: item.episodeTitle,
    watchedAt: item.updatedAt,
    source: "resume",
    positionSeconds: item.positionSeconds,
    durationSeconds: item.durationSeconds,
    timeLeftSeconds: item.timeLeftSeconds,
    progressPercent: item.progressPercent,
  };
}

export function ProfilePlaybackShelf({
  continueItems,
  recentItems,
}: {
  continueItems: ContinueWatchingItem[];
  recentItems: WatchHistoryItem[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const seen = new Set<string>();
  const items = [...continueItems.map(toHistoryItem), ...recentItems]
    .filter((item) => {
      const key = `${item.mediaType}:${item.tmdbId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10)
    .filter((item) => !dismissedKeys.has(item.id));
  if (items.length === 0) return null;

  const hasProgress = items.some((item) => item.source === "resume");

  const dismiss = (item: WatchHistoryItem) => {
    setDismissedKeys((previous) => {
      const next = new Set(previous);
      next.add(item.id);
      return next;
    });
    setPendingKey(item.id);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/playback?${playbackQuery(item)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error("remove failed");
        toast("Removed from Continue watching", "info");
        router.refresh();
      } catch {
        setDismissedKeys((previous) => {
          const next = new Set(previous);
          next.delete(item.id);
          return next;
        });
        toast("Couldn't remove this item", "error");
      } finally {
        setPendingKey(null);
      }
    });
  };

  return (
    <section className="mb-10 pt-1">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          {hasProgress && (
            <p className="mb-1 text-[10px] font-black uppercase tracking-[0.18em] text-primary">
              Pick up where you left off
            </p>
          )}
          <h2 className="text-[1.35rem] font-black tracking-[-0.025em] text-foreground">
            {hasProgress ? "Continue watching" : "Recently played"}
          </h2>
        </div>
        <Link
          href="/profile/history"
          className="text-xs font-bold text-foreground/55 transition hover:text-foreground"
        >
          History
        </Link>
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <ProfileStreamTile
            key={item.id}
            item={item}
            onDismiss={
              item.source === "resume" ? () => dismiss(item) : undefined
            }
            dismissing={isPending && pendingKey === item.id}
          />
        ))}
      </div>
    </section>
  );
}

export function RecentStreamsList({ items }: { items: WatchHistoryItem[] }) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <StreamRow key={item.id} item={item} />
      ))}
    </div>
  );
}
