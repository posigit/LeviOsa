"use client";

import { useState } from "react";
import Image from "next/image";
import { Check, Download, Pause, Play, Trash2 } from "lucide-react";
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
import { posterThumbUrl } from "@/lib/offline/store";
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
      return r.estimateBytes > 0
        ? `${Math.round(progress * 100)}% · ~${formatBytes(r.estimateBytes)}`
        : `${Math.round(progress * 100)}%`;
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

function Poster({ r }: { r: DownloadRecord }) {
  const [broken, setBroken] = useState(false);
  const src = posterThumbUrl(r.posterPath);
  const initial = cardTitle(r).trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-[#2c2c2e] to-[#151517]">
      <span className="text-3xl font-black text-white/15">{initial}</span>
      {src && !broken && (
        <Image
          src={src}
          alt=""
          fill
          sizes="(min-width: 768px) 180px, 33vw"
          className="object-cover"
          unoptimized
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}

/**
 * One poster tile for /library: tap = the sensible action for its state
 * (play / pause / resume), a delete affordance floats above it, and the
 * thumbnail comes from the image cached next to the download's bytes —
 * so the grid still renders with no connection.
 */
export function DownloadCard({
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
  // Orphaned active/queued state: no controller here owns it, so it will
  // never progress — the tap already retries (primary → tryResume); the
  // chip/labels must say that instead of pulsing like a live download.
  const stale = busy && !runningHere;
  const progress = r.totalSegments > 0 ? r.doneSegments / r.totalSegments : 0;
  const resumeAt = useResumeAt(r.state, r.key);
  const code = episodeCode(r);

  const tryResume = () => {
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

  const primary = () => {
    if (r.state === "done") {
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
    r.state === "done" && missingCount(r) > 0 ? (
      <span
        role="button"
        tabIndex={0}
        aria-label={`Repair ${missingCount(r)} missing chunks`}
        onClick={(e) => {
          e.stopPropagation();
          tryResume();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            tryResume();
          }
        }}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-amber-400 px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em] text-black"
      >
        <Download className="h-2.5 w-2.5" strokeWidth={3} />
        Partial
      </span>
    ) : r.state === "error" ? (
      <span className="rounded-full bg-red-500/90 px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em] text-white">
        Failed
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
      <span className="rounded-full bg-amber-400 px-2 py-[3px] text-[10px] font-black uppercase tracking-[0.08em] text-black">
        {Math.round(progress * 100)}%
      </span>
    ) : busy ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-black/75 px-2 py-[3px] text-[10px] font-black tabular-nums text-primary ring-1 ring-primary/40">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {Math.round(progress * 100)}%
      </span>
    ) : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={primary}
        aria-label={`${cardTitle(r)} — ${metaLabel(r, progress, stale)}`}
        className="block w-full text-left transition active:scale-[0.97]"
      >
        <div className="relative aspect-[2/3] overflow-hidden rounded-xl ring-1 ring-white/10">
          <Poster r={r} />
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/5 to-black/35"
          />
          {chip && <span className="absolute left-1.5 top-1.5">{chip}</span>}

          {r.state === "done" && (
            <span className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/65 ring-1 ring-white/15 backdrop-blur-sm">
              <Check className="h-3.5 w-3.5 text-success" strokeWidth={3.5} />
            </span>
          )}

          {(busy || (r.state === "paused" && progress > 0)) && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
              <div
                className={cn(
                  "h-full transition-all duration-300",
                  stale ? "bg-white/40" : "bg-primary"
                )}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
        </div>

        <p className="mt-1.5 line-clamp-2 text-[11px] font-bold leading-tight tracking-tight text-white/90">
          {cardTitle(r)}
        </p>
        <p className="mt-0.5 truncate text-[10px] font-semibold tabular-nums text-white/45">
          {code ? `${code} · ` : ""}
          {metaLabel(r, progress, stale)}
        </p>
        {resumeAt != null && (
          <p className="mt-0.5 truncate text-[10px] font-black tabular-nums text-primary">
            Resume {formatPlayerClock(resumeAt)}
          </p>
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
        className="absolute right-1.5 top-1.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-white/80 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-black/85 hover:text-white active:scale-95"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Poster grid for one group of records. */
export function DownloadGrid({
  records,
  onPlay,
  columns = 3,
}: {
  records: DownloadRecord[];
  onPlay: (record: DownloadRecord) => void;
  columns?: number;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-2.5 gap-y-4",
        columns === 4 ? "grid-cols-4" : "grid-cols-3"
      )}
    >
      {records.map((r) => (
        <DownloadCard key={r.key} record={r} onPlay={() => onPlay(r)} />
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
  const src = posterThumbUrl(r.posterPath);

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
    <div className="flex items-center gap-3 rounded-2xl bg-white/[0.05] p-2.5 ring-1 ring-white/[0.08]">
      <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded-lg bg-[#2c2c2e] ring-1 ring-white/10">
        {src && !broken && (
          <Image
            src={src}
            alt=""
            fill
            sizes="44px"
            className="object-cover"
            unoptimized
            onError={() => setBroken(true)}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold tracking-tight text-white">
          {cardTitle(r)}
        </p>
        <p className="mt-0.5 truncate text-[11px] font-semibold tabular-nums text-white/50">
          {stale
            ? `${Math.round(progress * 100)}% · tap to retry`
            : metaLabel(r, progress)}
        </p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/12">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
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
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-foreground ring-1 ring-border transition active:scale-95"
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
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-foreground/60 ring-1 ring-border transition hover:bg-secondary hover:text-foreground active:scale-95"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
