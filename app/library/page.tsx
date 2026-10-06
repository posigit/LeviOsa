"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight, Download, Wifi, WifiOff } from "lucide-react";
import {
  DownloadingRow,
  EpisodeDownloadList,
  MediaDownloadRow,
} from "@/components/download-grid";
import { requestOfflinePlay, useOnline } from "@/components/download-row";
import { StickyChrome } from "@/components/sticky-chrome";
import { ShowListRowSkeleton, Skeleton } from "@/components/skeletons";
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
import { cachePosterThumb, cacheStillThumb } from "@/lib/offline/store";
import { DEFAULT_VIX_SETTINGS, loadVixSettings } from "@/lib/vix-settings";
import { orderLibraryGroups, type LibraryRow } from "@/lib/offline/library";

/** Concurrency for poster backfill — a handful of titles, not a stampede. */
const BACKFILL_WORKERS = 3;

/**
 * Apple-TV-style section header: title-case show name, quiet count/size
 * detail on the right. Our touches stay: AMOLED black, yellow accents.
 */
function SectionHead({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="truncate text-[17px] font-extrabold tracking-tight text-white">
        {title}
      </h2>
      {detail && (
        <p className="shrink-0 text-[13px] tabular-nums text-white/40">
          {detail}
        </p>
      )}
    </div>
  );
}

/** Finished bytes in a group of rows (in-flight rows don't count yet). */
function groupBytes(rows: LibraryRow[]): number {
  return rows.reduce(
    (s, row) => s + (row.record.state === "done" ? row.record.sizeBytes : 0),
    0
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
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(
    null
  );
  // Chosen storage cap (500 MB … 5 GB in Downloads settings) — the meter
  // reads against this, not the browser's origin quota nobody picked.
  const [capMb, setCapMb] = useState<number>(DEFAULT_VIX_SETTINGS.downloadCapMb);
  const online = useOnline();

  useEffect(() => {
    const readCap = () => setCapMb(loadVixSettings().downloadCapMb);
    readCap();
    window.addEventListener("vix-settings-changed", readCap);
    return () => window.removeEventListener("vix-settings-changed", readCap);
  }, []);

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
   * Artwork backfill for rows saved before thumbnails existed (or from the
   * player, which never knew artwork). Episodes resolve their still (16:9
   * tile) on top of the series poster. Runs once per visit, only online,
   * only for titles still missing art — then the tiny images are cached
   * next to the download so they survive going offline and SW updates.
   */
  useEffect(() => {
    if (!ready || !online) return;
    // Active rows are owned by the engine (it looks the art up itself);
    // writing a snapshot over one could clobber live progress counts.
    const missing = getAllSync().filter(
      (r) =>
        (!r.posterPath || (r.type !== "movie" && !r.stillPath)) &&
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
            const q = new URLSearchParams({ type, id: String(rec.tmdbId) });
            if (type === "tv") {
              if (rec.season != null) q.set("season", String(rec.season));
              if (rec.episode != null) q.set("episode", String(rec.episode));
            }
            const res = await fetch(`/api/meta/poster?${q.toString()}`, {
              cache: "no-store",
            });
            if (!res.ok) continue;
            const data = (await res.json()) as {
              posterPath?: string | null;
              stillPath?: string | null;
            };
            const patch: {
              posterPath?: string | null;
              stillPath?: string | null;
            } = {};
            if (!rec.posterPath && typeof data.posterPath === "string") {
              patch.posterPath = data.posterPath;
            }
            if (
              type === "tv" &&
              !rec.stillPath &&
              typeof data.stillPath === "string"
            ) {
              patch.stillPath = data.stillPath;
            }
            if (cancelled) continue;
            // Re-read before writing: the other backfill (overview) may have
            // landed on this record since the queue snapshot — never clobber it.
            const fresh = getAllSync().find((x) => x.key === rec.key) ?? rec;
            const merged: {
              posterPath?: string | null;
              stillPath?: string | null;
            } = {};
            if (!fresh.posterPath && typeof patch.posterPath === "string") {
              merged.posterPath = patch.posterPath;
            }
            if (
              type === "tv" &&
              !fresh.stillPath &&
              typeof patch.stillPath === "string"
            ) {
              merged.stillPath = patch.stillPath;
            }
            if (Object.keys(merged).length === 0) continue;
            await upsertRecord({ ...fresh, ...merged });
            await cachePosterThumb(merged.posterPath);
            await cacheStillThumb(merged.stillPath);
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

  /**
   * Description backfill: rows render their cached overview under the title
   * (Netflix-style) — movies get the film synopsis, episodes get the episode
   * synopsis (scope=episode: never the series blurb repeated per row). One
   * pass per visit, only online, only for rows never fetched — empty string
   * is stored for "nothing there" so we don't refetch forever. Everything
   * keeps working offline: overview lives in the same IndexedDB record as
   * the download itself.
   */
  useEffect(() => {
    if (!ready || !online) return;
    const missing = getAllSync().filter(
      (r) =>
        r.overview == null &&
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
            const q = new URLSearchParams({
              type,
              tmdbId: String(rec.tmdbId),
              scope: "episode",
            });
            if (type === "tv") {
              if (rec.season != null) q.set("season", String(rec.season));
              if (rec.episode != null) q.set("episode", String(rec.episode));
            }
            const res = await fetch(`/api/meta/details?${q.toString()}`, {
              cache: "no-store",
            });
            if (!res.ok) continue;
            const data = (await res.json()) as { overview?: string | null };
            if (cancelled) continue;
            const fresh = getAllSync().find((x) => x.key === rec.key) ?? rec;
            if (fresh.overview != null) continue;
            await upsertRecord({
              ...fresh,
              overview: data.overview?.trim() || "",
            });
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
  const moviesBytes = useMemo(
    () =>
      movies
        .filter((r) => r.state === "done")
        .reduce((s, r) => s + r.sizeBytes, 0),
    [movies]
  );
  /**
   * Section lists: in-flight titles live only under "Downloading" (they're
   * already the hero there), the shelves below show finished/paused/partial
   * rows — no filter pills, one scroll does everything on a phone.
   */
  const shelfMovies = useMemo(
    () => movies.filter((r) => r.state !== "active" && r.state !== "queued"),
    [movies]
  );
  const shelfEpisodes = useMemo(
    () => episodes.filter((r) => r.state !== "active" && r.state !== "queued"),
    [episodes]
  );

  /** Episodes keep the show → season → episode order the list used. */
  const episodeGroups = useMemo(
    () =>
      shelfEpisodes.length > 0
        ? orderLibraryGroups(shelfEpisodes).filter((g) => g.rows.length > 0)
        : [],
    [shelfEpisodes]
  );

  const capBytes = capMb * 1024 * 1024;
  // Fill against the chosen cap; a non-empty library always gets a visible
  // sliver so 632 MB never renders as an invisible 0-width hairline.
  const capPct =
    capBytes > 0
      ? Math.min(100, Math.max(usedByApp > 0 ? 1.5 : 0, (usedByApp / capBytes) * 100))
      : 0;

  const play = (r: DownloadRecord) => {
    void touchRecord(r.key);
    requestOfflinePlay(r.key);
  };

  const emptyLibrary = ready && items.length === 0;

  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl pb-28">
      <StickyChrome
        className="bg-background/70 backdrop-blur-xl"
        contentClassName="px-4 pt-3 pb-2"
      >
        <div className="flex items-center gap-3">
          <Link
            href="/profile"
            aria-label="Back to profile"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-white ring-1 ring-white/10 transition-[transform,background-color] duration-150 ease-out hover:bg-white/25 active:scale-[0.96]"
          >
            <ArrowLeft className="h-5 w-5" />
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
        {/* ---------- Storage card (liquid glass, reads the chosen cap) ---------- */}
        <section className="glass-panel rounded-2xl p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[15px] font-bold text-white">Storage</p>
            <p className="shrink-0 text-[13px] tabular-nums text-white/50">
              {formatBytes(usedByApp)} of {formatBytes(capBytes)} cap
            </p>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${capPct}%` }}
            />
          </div>
          <p className="mt-2 text-xs tabular-nums text-white/35">
            {storage
              ? `${formatBytes(storage.quota - storage.usage)} free on this device`
              : `${readyItems.length} finished download${
                  readyItems.length === 1 ? "" : "s"
                }`}
          </p>
        </section>

        {/* ---------- Still coming down ---------- */}
        {inProgress.length > 0 && (
          <section className="space-y-3">
            <SectionHead
              title="Downloading"
              detail={`${inProgress.length}`}
            />
            <div className="space-y-2">
              {inProgress.map((r) => (
                <DownloadingRow key={r.key} record={r} />
              ))}
            </div>
          </section>
        )}

        {/* ---------- Poster shelves ---------- */}
        {!ready ? (
          <div role="status" aria-label="Loading downloads" className="space-y-5">
            <Skeleton className="h-[104px] w-full rounded-2xl" />
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, i) => (
                <ShowListRowSkeleton key={i} />
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
        ) : (
          <div className="space-y-8">
            {shelfMovies.length > 0 && (
              <section className="space-y-3">
                <SectionHead
                  title="Movies"
                  detail={
                    moviesBytes > 0 ? formatBytes(moviesBytes) : undefined
                  }
                />
                <div className="space-y-2">
                  {shelfMovies.map((r) => (
                    <MediaDownloadRow
                      key={r.key}
                      record={r}
                      onPlay={() => play(r)}
                    />
                  ))}
                </div>
              </section>
            )}

            {episodeGroups.map((group) => (
              <section key={group.id} className="space-y-3">
                <SectionHead
                  title={group.header ?? "Episodes"}
                  detail={
                    groupBytes(group.rows) > 0
                      ? formatBytes(groupBytes(group.rows))
                      : `${group.rows.length} ep`
                  }
                />
                <EpisodeDownloadList rows={group.rows} onPlay={play} />
              </section>
            ))}
          </div>
        )}

        <p className="pt-2 text-center text-xs leading-relaxed text-white/30">
          Downloads live on this device only. They stay playable with no
          signal.
        </p>
      </div>
    </div>
  );
}
