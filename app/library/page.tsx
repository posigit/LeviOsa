"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight, Download, Wifi, WifiOff } from "lucide-react";
import {
  DownloadGrid,
  DownloadingRow,
} from "@/components/download-grid";
import { requestOfflinePlay, useOnline } from "@/components/download-row";
import { StickyChrome } from "@/components/sticky-chrome";
import { Skeleton } from "@/components/skeletons";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  getAllSync,
  getManifest,
  subscribeDownloads,
  touchRecord,
  upsertRecord,
  type DownloadRecord,
} from "@/lib/downloads";
import { cachePosterThumb } from "@/lib/offline/store";
import { orderLibraryGroups } from "@/lib/offline/library";

type Filter = "all" | "movies" | "shows";

/** Concurrency for poster backfill — a handful of titles, not a stampede. */
const BACKFILL_WORKERS = 3;

function MicroLabel({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <p className="text-[11px] font-black uppercase tracking-[0.14em] text-white/45">
      {children}
      {typeof count === "number" && (
        <span className="ml-1.5 font-bold text-white/30 tabular-nums">
          {count}
        </span>
      )}
    </p>
  );
}

/**
 * Library: fully local (IndexedDB manifest + Cache Storage bytes), zero
 * server data — so the service worker can serve this shell with no
 * connection and everything still works. Play/delete are local; resume and
 * poster backfill refuse while offline (they come back on their own).
 */
export default function LibraryPage() {
  const [items, setItems] = useState<DownloadRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(
    null
  );
  const online = useOnline();

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

  /** How much room this origin has left — pure bonus, never blocks render. */
  useEffect(() => {
    let alive = true;
    const estimate = navigator.storage?.estimate?.();
    if (!estimate) return;
    void estimate
      .then((e) => {
        if (!alive || !e?.quota) return;
        setStorage({ usage: e.usage ?? 0, quota: e.quota });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Poster backfill for rows saved before thumbnails existed (or from the
   * player, which never knew a poster). Runs once per visit, only online,
   * only for titles still missing one — then the tiny image is cached next
   * to the download so it survives going offline and SW updates.
   */
  useEffect(() => {
    if (!ready || !online) return;
    // Active rows are owned by the engine (it looks the poster up itself);
    // writing a snapshot over one could clobber live progress counts.
    const missing = getAllSync().filter(
      (r) =>
        !r.posterPath &&
        r.state !== "active" &&
        r.state !== "queued"
    );
    if (missing.length === 0) return;
    let cancelled = false;
    const queue = [...missing];
    void Promise.all(
      Array.from({ length: BACKFILL_WORKERS }, async () => {
        while (queue.length > 0 && !cancelled) {
          const rec = queue.shift();
          if (!rec) break;
          try {
            const type = rec.type === "movie" ? "movie" : "tv";
            const res = await fetch(
              `/api/meta/poster?type=${type}&id=${rec.tmdbId}`,
              { cache: "no-store" }
            );
            if (!res.ok) continue;
            const data = (await res.json()) as { posterPath?: string | null };
            const posterPath =
              typeof data.posterPath === "string" ? data.posterPath : null;
            if (!posterPath || cancelled) continue;
            await upsertRecord({ ...rec, posterPath });
            await cachePosterThumb(posterPath);
          } catch {
            /* one flaky title must not stall the rest */
          }
        }
      })
    );
    return () => {
      cancelled = true;
    };
  }, [ready, online]);

  const movies = useMemo(() => items.filter((r) => r.type === "movie"), [items]);
  const episodes = useMemo(
    () => items.filter((r) => r.type !== "movie"),
    [items]
  );
  const readyItems = useMemo(
    () => items.filter((r) => r.state === "done"),
    [items]
  );
  const inProgress = useMemo(
    () => items.filter((r) => r.state === "active" || r.state === "queued"),
    [items]
  );
  const usedByApp = readyItems.reduce((s, r) => s + r.sizeBytes, 0);
  const filtered =
    filter === "movies" ? movies : filter === "shows" ? episodes : items;
  const showMovies = filter !== "shows";
  const showEpisodes = filter !== "movies";

  /** Episodes keep the show → season → episode order the list used. */
  const episodeGroups = useMemo(
    () =>
      showEpisodes && episodes.length > 0
        ? orderLibraryGroups(episodes).filter((g) => g.rows.length > 0)
        : [],
    [showEpisodes, episodes]
  );
  const filteredMovies = useMemo(
    () => (showMovies ? movies : []),
    [showMovies, movies]
  );

  const storagePct =
    storage && storage.quota > 0
      ? Math.min(100, Math.max(1, Math.round((storage.usage / storage.quota) * 100)))
      : null;

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: items.length },
    { key: "movies", label: "Movies", count: movies.length },
    { key: "shows", label: "Shows", count: episodes.length },
  ];

  const play = (r: DownloadRecord) => {
    void touchRecord(r.key);
    requestOfflinePlay(r.key);
  };

  const emptyLibrary = ready && items.length === 0;
  const emptyFiltered =
    ready && items.length > 0 && filtered.length === 0 && inProgress.length === 0;

  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl pb-28">
      <StickyChrome contentClassName="px-4 pt-3 pb-2">
        <div className="flex items-center gap-3">
          <Link
            href="/profile"
            aria-label="Back to profile"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white ring-1 ring-white/10 transition hover:bg-white/25 active:scale-95"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-black tracking-tight text-white">
              Library
            </h1>
            <p className="truncate text-xs tabular-nums text-white/45">
              {ready
                ? `${items.length} download${items.length === 1 ? "" : "s"}${
                    usedByApp > 0 ? ` · ${formatBytes(usedByApp)}` : ""
                  }`
                : "Reading local storage…"}
            </p>
          </div>
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] ring-1 transition",
              online
                ? "bg-white/[0.06] text-white/55 ring-white/10"
                : "bg-primary/15 text-primary ring-primary/40"
            )}
          >
            {online ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            {online ? "Online" : "Offline"}
          </span>
        </div>
      </StickyChrome>

      <div className="space-y-6 px-4 pt-4">
        {/* ---------- Slim storage strip ---------- */}
        <section>
          <div className="flex items-baseline justify-between gap-3 text-[11px] font-bold">
            <span className="uppercase tracking-[0.12em] text-white/45">
              Storage
            </span>
            <span className="tabular-nums text-white/40">
              {storagePct != null && storage
                ? `${formatBytes(storage.usage)} of ${formatBytes(storage.quota)}`
                : `${usedByApp > 0 ? formatBytes(usedByApp) : "0 B"} saved`}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                storagePct != null ? "bg-primary" : "bg-white/30"
              )}
              style={{ width: `${storagePct ?? (ready ? 100 : 0)}%` }}
            />
          </div>
        </section>

        {/* ---------- Still coming down ---------- */}
        {inProgress.length > 0 && (
          <section className="space-y-2">
            <MicroLabel count={inProgress.length}>Downloading</MicroLabel>
            <div className="space-y-2">
              {inProgress
                .filter(
                  (r) =>
                    filter === "all" ||
                    (filter === "movies"
                      ? r.type === "movie"
                      : r.type !== "movie")
                )
                .map((r) => (
                  <DownloadingRow key={r.key} record={r} />
                ))}
            </div>
          </section>
        )}

        {/* ---------- Medium filter ---------- */}
        <div role="tablist" aria-label="Filter downloads" className="flex gap-2">
          {tabs.map((t) => {
            const active = t.key === filter;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(t.key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-bold transition active:scale-[0.97]",
                  active
                    ? "bg-primary text-black"
                    : "bg-white/[0.06] text-white/55 ring-1 ring-white/10 hover:text-white"
                )}
              >
                <span>{t.label}</span>
                <span
                  className={cn(
                    "text-[11px] font-black tabular-nums",
                    active ? "text-black/55" : "text-white/35"
                  )}
                >
                  {ready ? t.count : "—"}
                </span>
              </button>
            );
          })}
        </div>

        {/* ---------- Poster shelves ---------- */}
        {!ready ? (
          <div role="status" aria-label="Loading downloads" className="space-y-5">
            <Skeleton className="h-3.5 w-24" />
            <div className="grid grid-cols-3 gap-x-2.5 gap-y-4">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                  <Skeleton className="h-2.5 w-4/5" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        ) : emptyLibrary ? (
          <div className="rounded-3xl border border-dashed border-white/15 bg-white/[0.03] px-6 py-12 text-center">
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-white/[0.06] ring-1 ring-white/10">
              <Download className="h-7 w-7 text-white/40" />
            </span>
            <p className="mt-4 text-lg font-extrabold text-white">
              No downloads yet
            </p>
            <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-white/45">
              Save movies and episodes to this device and watch them with no
              connection at all.
            </p>
            <Link
              href="/explore"
              className="mt-5 inline-flex items-center gap-1 rounded-full bg-primary px-5 py-3 text-sm font-bold text-black transition active:scale-95"
            >
              Find something to download
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        ) : emptyFiltered ? (
          <div className="rounded-3xl border border-dashed border-white/12 bg-white/[0.03] px-6 py-10 text-center">
            <p className="text-sm font-semibold text-white/50">
              Nothing in {filter === "movies" ? "movies" : "shows"} yet.
            </p>
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="mt-3 text-sm font-bold text-primary active:scale-95"
            >
              Show all downloads
            </button>
          </div>
        ) : (
          <div className="space-y-7">
            {showMovies && filteredMovies.length > 0 && (
              <section className="space-y-3">
                <MicroLabel count={filteredMovies.length}>Movies</MicroLabel>
                <DownloadGrid records={filteredMovies} onPlay={play} />
              </section>
            )}

            {episodeGroups.map((group) => (
              <section key={group.id} className="space-y-3">
                <MicroLabel count={group.rows.length}>
                  {group.header ?? "Episodes"}
                </MicroLabel>
                <DownloadGrid
                  records={group.rows.map((row) => row.record)}
                  onPlay={play}
                />
              </section>
            ))}
          </div>
        )}

        <p className="pt-2 text-center text-xs leading-relaxed text-white/30">
          Downloads live on this device only — they stay playable with no
          signal.
        </p>
      </div>
    </div>
  );
}
