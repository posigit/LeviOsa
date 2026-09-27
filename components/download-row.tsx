"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Pause, Play, Trash2 } from "lucide-react";
import { useToast } from "@/components/toast";
import {
  formatBytes,
  type DownloadRecord,
} from "@/lib/downloads";
import {
  deleteDownload,
  isDownloadActive,
  isDownloadQueued,
  pauseDownload,
  resumeDownload,
} from "@/lib/downloader";

export function requestOfflinePlay(key: string) {
  window.dispatchEvent(
    new CustomEvent("tvtime:play-offline", { detail: { key } })
  );
}

/**
 * Global completion toast. The engine broadcasts tvtime:download-done;
 * this shows "Saved · View" which jumps to the library. Mount once
 * inside the toast provider.
 */
export function DownloadDoneNotifier() {
  const { toast } = useToast();
  const router = useRouter();
  useEffect(() => {
    const onDone = (e: Event) => {
      const d = (e as CustomEvent<{ key?: string; title?: string }>).detail;
      // Record titles use " — " (Show — S1E3); the toast drops it — no dashes.
      const title = (d?.title ?? "").replaceAll(" — ", " ").trim();
      toast(title ? `Saved · ${title}` : "Saved", "success", {
        label: "View",
        onClick: () => router.push("/library"),
      });
    };
    window.addEventListener("tvtime:download-done", onDone);
    return () => window.removeEventListener("tvtime:download-done", onDone);
  }, [toast, router]);
  return null;
}

/** True while the browser reports a connection (resume/retry need one). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function qualityLabel(r: DownloadRecord): string {
  const q = r.quality === "best" ? "Best" : `${r.quality}p`;
  return r.usedSource ? `${q} · ${r.usedSource}` : q;
}

/**
 * One download row: progress, play/pause/resume/delete. Shared by the
 * Download settings sheet and the /library page. Resume/retry
 * refuse while offline (fetching is impossible); play/delete stay live.
 */
export function DownloadRow({
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

  const tryResume = () => {
    if (!online) {
      toast("You're offline — reconnect to download", "error");
      return;
    }
    const req =
      r.type === "movie"
        ? {
            type: "movie" as const,
            tmdbId: r.tmdbId,
            title: r.title,
            subtitle: r.subtitle,
          }
        : {
            type: "tv" as const,
            tmdbId: r.tmdbId,
            season: r.season,
            episode: r.episode,
            title: r.title,
            subtitle: r.subtitle,
          };
    void resumeDownload(req).catch((e: unknown) =>
      toast(e instanceof Error ? e.message : "Couldn't resume", "error")
    );
  };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-secondary px-3.5 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold tracking-tight text-foreground">{r.title}</p>
        {r.subtitle && (
          <p className="truncate text-xs text-foreground/45">{r.subtitle}</p>
        )}
        <p className="mt-1 text-[11px] font-semibold tabular-nums text-foreground/40">
          {r.state === "done" && r.sizeBytes > 0
            ? `${formatBytes(r.sizeBytes)} · ${qualityLabel(r)}`
            : runningHere
              ? `${Math.round(progress * 100)}%${r.estimateBytes > 0 ? ` · ~${formatBytes(r.estimateBytes)}` : ""}`
              : stale
                ? `${Math.round(progress * 100)}% · tap to retry`
              : r.state === "paused"
                ? `Paused · ${Math.round(progress * 100)}%`
                : r.state === "error"
                  ? (r.error ?? "Failed")
                  : r.state === "missing"
                    ? "Removed — download again"
                    : "Waiting…"}
        </p>
        {runningHere && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {r.state === "done" && (
          <button
            type="button"
            onClick={onPlay}
            aria-label={`Play ${r.title} offline`}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-primary text-black transition active:scale-95"
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
        )}
        {(r.state === "paused" ||
          r.state === "error" ||
          r.state === "missing" ||
          stale) && (
          <button
            type="button"
            onClick={tryResume}
            aria-label="Resume download"
            title={!online ? "Needs connection" : undefined}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-secondary text-foreground ring-1 ring-border transition hover:bg-secondary active:scale-95 disabled:opacity-40"
          >
            {r.state === "paused" ? (
              <Play className="h-4 w-4 fill-current" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
        )}
        {runningHere && (
          <button
            type="button"
            onClick={() => void pauseDownload(r.key)}
            aria-label="Pause download"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-secondary text-foreground ring-1 ring-border transition hover:bg-secondary active:scale-95"
          >
            <Pause className="h-4 w-4" />
          </button>
        )}
        {/* Delete is always available — mid-download too. deleteDownload
            aborts an in-flight fetch before removing bytes + record. */}
        <button
          type="button"
          onClick={() => {
            void deleteDownload(r.key).catch((e: unknown) =>
              toast(e instanceof Error ? e.message : "Couldn't delete", "error")
            );
          }}
          aria-label={`Delete ${r.title}`}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-secondary text-foreground/60 ring-1 ring-border transition hover:bg-secondary hover:text-foreground active:scale-95"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        {r.state === "done" && (
          <span className="flex h-6 w-6 items-center justify-center">
            <Check className="h-4 w-4 text-success" strokeWidth={3} />
          </span>
        )}
      </div>
    </div>
  );
}
