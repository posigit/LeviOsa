"use client";

import { useEffect, useState } from "react";
import { Check, Download, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { loadVixSettings } from "@/lib/vix-settings";
import {
  downloadKey,
  ensurePersisted,
  formatBytes,
  getManifest,
  getRecordSync,
  subscribeDownloads,
  type DownloadRecord,
} from "@/lib/downloads";
import {
  cancelDownload,
  isDownloadActive,
  isDownloadQueued,
  pauseDownload,
  resumeDownload,
  startDownload,
  type DownloadRequest,
} from "@/lib/downloader";

export type DownloadItem = DownloadRequest;

/** Reactive gate — download buttons only render while mode is on. */
export function useDownloadMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        setOn(loadVixSettings().downloadMode === true);
      } catch {
        /* ignore */
      }
    };
    read();
    window.addEventListener("vix-settings-changed", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("vix-settings-changed", read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return on;
}

export function useDownloadRecord(key: string | null): DownloadRecord | null {
  const [rec, setRec] = useState<DownloadRecord | null>(() =>
    key ? getRecordSync(key) : null
  );
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void getManifest().then(() => {
      if (alive) setRec(getRecordSync(key));
    });
    const unsub = subscribeDownloads(() => {
      if (!alive) return;
      const next = getRecordSync(key);
      setRec(next ? { ...next } : null);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [key]);
  return rec;
}

function stateLabel(rec: DownloadRecord | null): string {
  if (!rec) return "Download for offline";
  if (
    (rec.state === "active" || rec.state === "queued") &&
    !isDownloadActive(rec.key) &&
    !isDownloadQueued(rec.key)
  ) {
    return "Download stopped — tap to retry";
  }
  switch (rec.state) {
    case "active":
    case "queued":
      return "Downloading — tap to pause";
    case "paused":
      return "Paused — tap to resume";
    case "done":
      return isPartial(rec)
        ? `Incomplete — ${rec.missing!.length} chunk(s) missing, tap to repair`
        : "Downloaded — manage in Library";
    case "error":
      return `Failed (${rec.error ?? "unknown error"}) — tap to retry`;
    case "missing":
      return "File no longer stored — tap to download again";
  }
}

/** Finished but still owing segments (gap budget / quota holes). */
function isPartial(rec: DownloadRecord | null): boolean {
  return !!rec && rec.state === "done" && (rec.missing?.length ?? 0) > 0;
}

function ProgressRing({ progress }: { progress: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth="2.5"
      />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, progress)))}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

/**
 * Netflix-style download button. Renders nothing unless download mode is on.
 * `icon` fits episode rows / player chrome; `bar` fits the movie action row.
 */
export function DownloadButton({
  item,
  variant = "icon",
  className,
}: {
  item: DownloadItem;
  variant?: "icon" | "bar";
  className?: string;
}) {
  const mode = useDownloadMode();
  const { toast } = useToast();
  const key = downloadKey(
    item.type === "movie" ? "movie" : "episode",
    item.tmdbId,
    item.season,
    item.episode
  );
  const rec = useDownloadRecord(mode ? key : null);

  if (!mode) return null;

  const busy = rec?.state === "active" || rec?.state === "queued";
  const runningHere = !!rec && busy && (isDownloadActive(key) || isDownloadQueued(key));
  const partial = isPartial(rec);
  const progress =
    rec && rec.totalSegments > 0 ? rec.doneSegments / rec.totalSegments : 0;

  const onTap = () => {
    // persist() only sticks when it starts inside the tap, before any await.
    void ensurePersisted();
    try {
      if (!rec || rec.state === "error" || rec.state === "missing" || rec.state === "paused") {
        void (rec ? resumeDownload(item) : startDownload(item)).catch((e: unknown) =>
          toast(e instanceof Error ? e.message : "Download failed", "error")
        );
      } else if (partial) {
        // Done but owing holes: re-run as a cache-hit repair pass.
        void resumeDownload(item).catch((e: unknown) =>
          toast(e instanceof Error ? e.message : "Couldn't repair", "error")
        );
      } else if (runningHere) {
        void pauseDownload(key);
      } else if (busy) {
        // Stale active/queued row (tab was killed). Continue, don't pause a corpse.
        void resumeDownload(item).catch((e: unknown) =>
          toast(e instanceof Error ? e.message : "Couldn't resume", "error")
        );
      }
      // done → no-op (manage/delete lives in Library)
    } catch {
      /* ignore */
    }
  };

  if (variant === "bar") {
    return (
      <button
        type="button"
        onClick={onTap}
        title={stateLabel(rec)}
        aria-label={stateLabel(rec)}
        className={cn(
          "flex w-full items-center gap-3 rounded-full bg-secondary px-4 py-3 text-sm font-bold text-foreground ring-1 ring-border backdrop-blur-xl transition hover:bg-secondary active:scale-[0.99]",
          className
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary ring-1 ring-border">
          {rec?.state === "done" ? (
            partial ? (
              <Download className="h-4 w-4 text-primary" />
            ) : (
              <Check className="h-4 w-4 text-success" strokeWidth={3} />
            )
          ) : busy ? (
            <span className="text-primary">
              <ProgressRing progress={progress} />
            </span>
          ) : rec?.state === "paused" ? (
            <Play className="h-4 w-4 fill-current" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </span>
        <span className="min-w-0 flex-1 text-left">
          {rec?.state === "done"
            ? partial
              ? `Partial · ${rec.missing!.length} missing — tap to repair`
              : "Downloaded"
            : runningHere
              ? `Downloading… ${Math.round(progress * 100)}%`
              : busy
                ? `${Math.round(progress * 100)}% · tap to retry`
              : rec?.state === "paused"
                ? `Paused · ${Math.round(progress * 100)}%`
                : rec?.state === "error"
                  ? "Download failed — tap to retry"
                  : "Download for offline"}
        </span>
        {rec && rec.state !== "done" && rec.estimateBytes > 0 && (
          <span className="shrink-0 text-xs font-semibold text-foreground/50">
            ~{formatBytes(rec.estimateBytes)}
          </span>
        )}
        {rec?.state === "done" && rec.sizeBytes > 0 && (
          <span className="shrink-0 text-xs font-semibold text-foreground/50">
            {formatBytes(rec.sizeBytes)}
          </span>
        )}
        {busy && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Cancel download"
            onClick={(e) => {
              e.stopPropagation();
              cancelDownload(key);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                cancelDownload(key);
              }
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-bold text-foreground/70 hover:bg-secondary"
          >
            ×
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onTap}
      title={stateLabel(rec)}
      aria-label={stateLabel(rec)}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 backdrop-blur-xl transition-all active:scale-95",
        partial
          ? "bg-primary/15 text-primary ring-primary/40"
          : rec?.state === "done"
            ? "bg-success/20 text-success ring-success/50"
            : "bg-secondary text-foreground/80 ring-border hover:bg-secondary",
        className
      )}
    >
      {rec?.state === "done" ? (
        partial ? (
          <Download className="h-4 w-4" />
        ) : (
          <Check className="h-4 w-4" strokeWidth={3} />
        )
      ) : busy ? (
        <span className="text-primary">
          <ProgressRing progress={progress} />
        </span>
      ) : rec?.state === "paused" ? (
        <Play className="h-3.5 w-3.5 fill-current" />
      ) : rec?.state === "error" ? (
        <Download className="h-4 w-4 text-red-400" />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </button>
  );
}

/** Pause glyph for the active state (used by inline rows that want it). */
export function DownloadPauseIcon({ className }: { className?: string }) {
  return <Pause className={className} />;
}
