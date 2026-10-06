"use client";

import { useState } from "react";
import Image from "next/image";
import { Download, Pause, Play, Trash2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { useOnline, useResumeAt } from "@/components/download-row";
import { formatBytes, missingCount, type DownloadRecord } from "@/lib/downloads";
import {
  deleteDownload,
  isDownloadActive,
  isDownloadQueued,
  pauseDownload,
  resumeDownload,
} from "@/lib/downloader";
import { formatPlayerClock } from "@/lib/player-progress";
import { posterThumbUrl, stillThumbUrl } from "@/lib/offline/store";
import type { LibraryRow } from "@/lib/offline/library";
import { cn } from "@/lib/utils";

/** Short second line under a poster tile. */
function metaLabel(r: DownloadRecord, progress: number, stale = false): string {
  const quality = r.quality === "best" ? "Best" : `${r.quality}p`;
  switch (r.state) {
    case "done":
      if (missingCount(r) > 0) return `Partial · ${missingCount(r)} missing`;
      return r.sizeBytes > 0 ? `${formatBytes(r.sizeBytes)} · ${quality}` : quality;
    case "active":
    case "queued":
      // Orphaned row (crash / other tab): the state never moves again —
      // say so instead of showing a frozen percent as if it were live.
      if (stale) return `${Math.round(progress * 100)}% · tap to retry`;
      return `${Math.round(progress * 100)}%`;
    case "paused":
      return `Paused · ${Math.round(progress * 100)}%`;
    case "error":
      return r.error ?? "Download failed";
    case "missing":
      return "Removed from device";
  }
}

/** Episode line 1: the episode name when we have it, else the show name. */
function cardTitle(r: DownloadRecord): string {
  if (r.type === "movie") return r.title;
  return r.subtitle?.trim() || r.title;
}

/** "S1E4" — sits in front of the meta line for episodes. */
function episodeCode(r: DownloadRecord): string | null {
  if (r.type === "movie" || r.season == null || r.episode == null) return null;
  return `S${r.season}E${r.episode}`;
}

/**
 * Netflix-style download row for /library — movies (portrait poster thumb)
 * and episodes (16:9 still, poster crops in when the still is missing) both
 * land here: title, `SxxExx · size · quality` meta, the cached description
 * on movies, a yellow Resume line, and a 44px action circle showing what a
 * tap does (play / pause / retry). The row itself is the primary button —
 * play, pause, resume and retry all live there — with delete (and repair
 * for partial files) as sibling targets, so everything stays a 44px touch.
 */
export function MediaDownloadRow({
  record: r,
  onPlay,
}: {
  record: DownloadRecord;
  onPlay: () => void;
}) {
  const { toast } = useToast();
  const online = useOnline();
  const busy = r.state === "active" || r.state === "queued";
  const runningHere = busy && (isDownloadActive(r.key) || isDownloadQueued(r.key));
  const stale = busy && !runningHere;
  const progress = r.totalSegments > 0 ? r.doneSegments / r.totalSegments : 0;
  const resumeAt = useResumeAt(r.state, r.key);
  const movie = r.type === "movie";
  const code = episodeCode(r);
  const done = r.state === "done";
  const partial = done && missingCount(r) > 0;
  const showBar = busy || (r.state === "paused" && progress > 0);
  const [broken, setBroken] = useState(false);
  // Episodes: 16:9 still (series poster crops in). Movies: portrait poster
  // at the record's own 2:3 ratio — never crop a poster into a landscape box.
  const src = movie ? posterThumbUrl(r.posterPath) : stillThumbUrl(r.stillPath) ?? posterThumbUrl(r.posterPath);
  const initial = cardTitle(r).trim().charAt(0).toUpperCase() || "?";
  const overview = movie && r.overview ? r.overview : null;

  const tryResume = () => {
    if (!online) {
      toast("You're offline — reconnect to download", "error");
      return;
    }
    void resumeDownload({
      type: movie ? "movie" : "tv",
      tmdbId: r.tmdbId,
      season: r.season,
      episode: r.episode,
      title: r.title,
      subtitle: r.subtitle,
      poster: r.posterPath,
    }).catch((e: unknown) =>
      toast(e instanceof Error ? e.message : "Couldn't resume", "error")
    );
  };

  const primary = () => {
    if (done) {
      onPlay();
      return;
    }
    if (busy && runningHere) {
      void pauseDownload(r.key);
      return;
    }
    tryResume();
  };

  const chip =
    partial || r.state === "error" ? (
      <span
        className={cn(
          "rounded-full px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em]",
          partial ? "bg-primary text-black" : "bg-red-500/90 text-white"
        )}
      >
        {partial ? "Partial" : "Failed"}
      </span>
    ) : r.state === "missing" ? (
      <span className="rounded-full bg-white/85 px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em] text-black">
        Removed
      </span>
    ) : r.state === "paused" ? (
      <span className="rounded-full bg-black/75 px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em] text-white ring-1 ring-white/20">
        {Math.round(progress * 100)}%
      </span>
    ) : stale ? (
      <span className="rounded-full bg-primary px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em] text-black">
        Retry
      </span>
    ) : busy ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-black/75 px-2 py-[3px] text-[10px] font-black tabular-nums text-primary ring-1 ring-primary/40">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {Math.round(progress * 100)}%
      </span>
    ) : null;

  return (
    <div className="flex items-center gap-2 rounded-xl bg-card p-2.5">
      <button
        type="button"
        onClick={primary}
        aria-label={`${cardTitle(r)} — ${metaLabel(r, progress, stale)}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left transition-[transform,opacity] duration-150 ease-out active:scale-[0.99]"
      >
        <span
          className={cn(
            "relative block shrink-0 overflow-hidden rounded-lg bg-[#2c2c2e]",
            movie ? "h-[100px] w-[67px]" : "h-[72px] w-[116px]"
          )}
        >
          <span className="absolute inset-0 grid place-items-center">
            <span className="text-xl font-black text-white/15">{initial}</span>
          </span>
          {src && !broken && (
            <Image
              src={src}
              alt=""
              fill
              sizes={movie ? "67px" : "116px"}
              className="object-cover"
              unoptimized
              onError={() => setBroken(true)}
            />
          )}
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20"
          />
          {chip && <span className="absolute left-1.5 top-1.5">{chip}</span>}
          {showBar && (
            <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
              <span
                className={cn(
                  "block h-full transition-[width] duration-300 ease-out",
                  stale ? "bg-white/40" : "bg-primary"
                )}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1 py-0.5">
          <span className="block truncate text-[15px] font-bold leading-tight text-foreground">
            {cardTitle(r)}
          </span>
          <span className="mt-0.5 block truncate text-[13px] font-medium tabular-nums text-muted-foreground">
            {code ? `${code} · ` : ""}
            {metaLabel(r, progress, stale)}
          </span>
          {overview && (
            <span className="mt-1 line-clamp-2 block text-[13px] font-normal leading-snug text-muted-foreground/80">
              {overview}
            </span>
          )}
          {resumeAt != null && (
            <span className="mt-0.5 block truncate text-xs font-bold tabular-nums text-primary">
              Resume {formatPlayerClock(resumeAt)}
            </span>
          )}
        </span>

        <span
          aria-hidden
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-full",
            done && !partial
              ? "bg-primary text-black"
              : "bg-secondary text-foreground ring-1 ring-border"
          )}
        >
          {done && !partial ? (
            <Play className="h-4 w-4 fill-current" />
          ) : busy && runningHere ? (
            <Pause className="h-4 w-4" />
          ) : r.state === "paused" ? (
            <Play className="h-4 w-4 fill-current" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </span>
      </button>

        {/* Partial rows add a ringed repair target beside the play circle:
            one plays the file as-is, the arrow re-downloads the gaps. */}
        {partial && (
        <button
          type="button"
          onClick={tryResume}
          aria-label={`Repair ${cardTitle(r)}`}
          title={online ? "Repair download" : "Needs connection"}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-secondary text-primary ring-1 ring-primary/40 transition-[transform,background-color] duration-150 ease-out active:scale-[0.96]"
        >
          <Download className="h-4 w-4" />
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          void deleteDownload(r.key).catch((e: unknown) =>
            toast(e instanceof Error ? e.message : "Couldn't delete", "error")
          );
        }}
        aria-label={`Delete ${cardTitle(r)}`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-secondary text-foreground/60 ring-1 ring-border transition-[transform,background-color,color] duration-150 ease-out hover:text-foreground active:scale-[0.96]"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Episode group: season sublabels stay, rows go full-width Netflix-style. */
export function EpisodeDownloadList({
  rows,
  onPlay,
}: {
  rows: LibraryRow[];
  onPlay: (record: DownloadRecord) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map(({ record, seasonLabel }) => (
        <div key={record.key} className="space-y-2">
          {seasonLabel && (
            <p className="pt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-white/40">
              {seasonLabel}
            </p>
          )}
          <MediaDownloadRow record={record} onPlay={() => onPlay(record)} />
        </div>
      ))}
    </div>
  );
}

/** Poster + progress strip for titles that are still coming down. */
export function DownloadingRow({ record: r }: { record: DownloadRecord }) {
  const { toast } = useToast();
  const online = useOnline();
  const busy = r.state === "active" || r.state === "queued";
  const runningHere = busy && (isDownloadActive(r.key) || isDownloadQueued(r.key));
  const stale = busy && !runningHere;
  const progress = r.totalSegments > 0 ? r.doneSegments / r.totalSegments : 0;
  const [broken, setBroken] = useState(false);
  const still = r.type !== "movie" ? stillThumbUrl(r.stillPath) : null;
  const src = still ?? posterThumbUrl(r.posterPath);

  const action = () => {
    if (busy && runningHere) {
      void pauseDownload(r.key);
      return;
    }
    if (!online) {
      toast("You're offline — reconnect to download", "error");
      return;
    }
    void resumeDownload({
      type: r.type === "movie" ? "movie" : "tv",
      tmdbId: r.tmdbId,
      season: r.season,
      episode: r.episode,
      title: r.title,
      subtitle: r.subtitle,
      poster: r.posterPath,
    }).catch((e: unknown) =>
      toast(e instanceof Error ? e.message : "Couldn't resume", "error")
    );
  };

  return (
    <div className="flex items-center gap-3 rounded-xl bg-card p-2.5">
      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-lg bg-[#2c2c2e]",
          still ? "aspect-video w-[116px]" : "h-[72px] w-12"
        )}
      >
        {src && !broken && (
          <Image
            src={src}
            alt=""
            fill
            sizes={still ? "96px" : "44px"}
            className="object-cover"
            unoptimized
            onError={() => setBroken(true)}
          />
        )}
      </div>

      <div className="min-w-0 flex-1 py-0.5">
        <p className="truncate text-[15px] font-bold leading-tight tracking-tight text-white">
          {cardTitle(r)}
        </p>
        <p className="mt-0.5 truncate text-[13px] font-medium tabular-nums text-white/50">
          {stale
            ? `${Math.round(progress * 100)}% · tap to retry`
            : metaLabel(r, progress)}
        </p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300 ease-out",
              stale ? "bg-white/40" : "bg-primary"
            )}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={action}
        aria-label={runningHere ? "Pause download" : "Resume download"}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-secondary text-foreground ring-1 ring-border transition-[transform,background-color] duration-150 ease-out active:scale-[0.96]"
      >
        {runningHere ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4 fill-current" />
        )}
      </button>

      <button
        type="button"
        onClick={() => {
          void deleteDownload(r.key).catch((e: unknown) =>
            toast(e instanceof Error ? e.message : "Couldn't delete", "error")
          );
        }}
        aria-label={`Delete ${cardTitle(r)}`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-secondary text-foreground/60 ring-1 ring-border transition-[transform,background-color,color] duration-150 ease-out hover:text-foreground active:scale-[0.96]"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
