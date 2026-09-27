"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import {
  DownloadLibraryList,
  requestOfflinePlay,
} from "@/components/download-row";
import {
  formatBytes,
  getAllSync,
  getManifest,
  subscribeDownloads,
  touchRecord,
  type DownloadRecord,
} from "@/lib/downloads";

/**
 * Library: fully local (IndexedDB manifest + Cache Storage
 * bytes), zero server data — so the service worker can serve this shell
 * with no connection and everything still works. Play/delete are local;
 * resume/retry refuse while offline (rows handle that themselves).
 */
export default function LibraryPage() {
  const [items, setItems] = useState<DownloadRecord[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void getManifest().then(() => {
      if (alive) {
        setItems(getAllSync());
        setReady(true);
      }
    });
    const unsub = subscribeDownloads(() => {
      if (alive) setItems(getAllSync());
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const doneCount = items.filter((r) => r.state === "done").length;
  const usedByApp = items
    .filter((r) => r.state === "done")
    .reduce((s, r) => s + r.sizeBytes, 0);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl px-4 pb-28 pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-3">
        <Link
          href="/profile"
          aria-label="Back to profile"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-foreground ring-1 ring-border transition hover:bg-secondary"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-black tracking-tight text-foreground">Library</h1>
          <p className="text-xs tabular-nums text-foreground/45">
            {doneCount}
            {usedByApp > 0 ? ` · ${formatBytes(usedByApp)}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {!ready ? (
          <p className="py-10 text-center text-sm text-foreground/40">Loading…</p>
        ) : items.length === 0 ? (
          <div className="rounded-2xl bg-secondary px-4 py-10 text-center ring-1 ring-border">
            <Download className="mx-auto h-5 w-5 text-foreground/30" />
            <p className="mt-2 text-sm font-semibold text-foreground/50">
              No downloads yet
            </p>
          </div>
        ) : (
          <DownloadLibraryList
            records={items}
            onPlay={(r) => {
              void touchRecord(r.key);
              requestOfflinePlay(r.key);
            }}
          />
        )}
      </div>
    </div>
  );
}
