"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ChevronDown, Loader2, Star } from "lucide-react";
import { backdropUrl, posterUrl, type TmdbMovieCard } from "@/lib/tmdb";
import { MovieWatchButton } from "@/components/movie-watch-button";
import { PosterGridSkeleton } from "@/components/skeletons";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const MAX_PAGES = 10;

function compactVotes(n?: number): string | null {
  if (n == null || n <= 0) return null;
  return Intl.NumberFormat("en", { notation: "compact" }).format(n);
}

function GridCard({
  item,
  rank,
  status,
  showYear,
}: {
  item: TmdbMovieCard;
  rank: number;
  status: string | null;
  showYear: boolean;
}) {
  const poster = posterUrl(item.poster_path, "w342");
  const year = item.release_date?.slice(0, 4);
  const votes = compactVotes(item.vote_count);
  return (
    <div className="min-w-0">
      <Link
        href={`/movie/${item.id}`}
        className="relative block aspect-[2/3] overflow-hidden rounded-xl bg-card ring-1 ring-white/10 transition active:scale-[0.98]"
      >
        {poster ? (
          <Image
            src={poster}
            alt={item.title}
            fill
            sizes="(max-width: 480px) 33vw, 200px"
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-2 text-center text-xs font-bold text-white/50">
            {item.title}
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-black tabular-nums text-white backdrop-blur-sm">
          #{rank}
        </span>
      </Link>
      <Link href={`/movie/${item.id}`} className="mt-1 block min-w-0">
        <p className="truncate text-xs font-bold text-white">{item.title}</p>
      </Link>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <span className="inline-flex min-w-0 items-center gap-0.5 text-[11px] font-semibold text-white/60">
          <Star className="h-3 w-3 shrink-0 fill-primary text-primary" />
          {item.vote_average ? item.vote_average.toFixed(1) : "–"}
          {votes ? <span className="truncate text-white/35">· {votes}</span> : null}
          {showYear && year ? (
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = `/movie/year/${year}`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") window.location.href = `/movie/year/${year}`;
              }}
              className="ml-1 shrink-0 text-white/40 underline-offset-2 hover:text-white/80 hover:underline"
            >
              {year}
            </span>
          ) : null}
        </span>
        <MovieWatchButton
          tmdbId={item.id}
          initialStatus={status}
          variant="compact"
        />
      </div>
    </div>
  );
}

function PodiumCard({
  item,
  rank,
  large,
}: {
  item: TmdbMovieCard;
  rank: number;
  large?: boolean;
}) {
  const bg =
    backdropUrl(item.backdrop_path, large ? "w780" : "w300") ??
    posterUrl(item.poster_path, "w500");
  const votes = compactVotes(item.vote_count);
  return (
    <Link
      href={`/movie/${item.id}`}
      className={cn(
        "group relative block overflow-hidden bg-card transition active:scale-[0.99]",
        large
          ? "h-52 rounded-3xl ring-1 ring-[#e9e5d2]/50 shadow-[0_20px_60px_-16px_rgba(233,229,210,0.35)]"
          : "h-32 rounded-2xl ring-1 ring-white/15"
      )}
    >
      {bg ? (
        <Image
          src={bg}
          alt=""
          fill
          sizes={large ? "100vw" : "50vw"}
          className="object-cover object-top transition duration-300 group-hover:scale-[1.03]"
          unoptimized
          priority={large}
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/45 to-transparent" />
      <span
        className={cn(
          "top-ten-rank absolute bottom-1 left-2 select-none",
          large ? "text-[4.5rem]" : "text-[3rem]",
          rank === 1 && "top-ten-rank-gold"
        )}
        aria-hidden
      >
        {rank}
      </span>
      <div className={cn("absolute inset-x-0 bottom-0", large ? "pl-16 pr-3 pb-3" : "pl-11 pr-2 pb-2")}>
        <p className={cn("truncate font-black text-white drop-shadow", large ? "text-lg" : "text-[13px]")}>
          {item.title}
        </p>
        <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-white/70">
          <Star className="h-3 w-3 fill-primary text-primary" />
          {item.vote_average ? item.vote_average.toFixed(1) : "–"}
          {votes ? <span className="text-white/45">· {votes} votes</span> : null}
        </p>
      </div>
    </Link>
  );
}

export function RankedGrid({
  kind,
  value,
  initialItems,
  initialStatuses,
  totalPages,
  totalResults,
  showYear,
  emptyLabel,
}: {
  kind: "year" | "decade";
  value: string;
  initialItems: TmdbMovieCard[];
  initialStatuses: Record<number, string | null>;
  totalPages: number;
  totalResults: number;
  showYear: boolean;
  emptyLabel: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [statuses, setStatuses] = useState(initialStatuses);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const shownPages = Math.min(totalPages, MAX_PAGES);
  const canMore = page < shownPages;

  async function loadMore() {
    if (loading || !canMore) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/movies/ranked?kind=${kind}&value=${encodeURIComponent(value)}&page=${page + 1}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: {
        items?: TmdbMovieCard[];
        statuses?: Record<number, string | null>;
      } = await res.json();
      const next = Array.isArray(data.items) ? data.items : [];
      setItems((prev) => [...prev, ...next]);
      if (data.statuses) {
        setStatuses((prev) => ({ ...prev, ...data.statuses }));
      }
      setPage((p) => p + 1);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">{emptyLabel}</p>
    );
  }

  const [first, second, third, ...rest] = items;
  const statusOf = (id: number) => statuses[id] ?? null;

  return (
    <div>
      {/* Podium — the answer to "what's the best?" */}
      {first && (
        <PodiumCard item={first} rank={1} large />
      )}
      {second && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <PodiumCard item={second} rank={2} />
          {third && <PodiumCard item={third} rank={3} />}
        </div>
      )}

      {/* Long tail — poster grid, ranks continue */}
      {rest.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-x-2 gap-y-4">
          {rest.map((item, i) => (
            <GridCard
              key={item.id}
              item={item}
              rank={i + 4}
              status={statusOf(item.id)}
              showYear={showYear}
            />
          ))}
        </div>
      )}

      {/* Show More */}
      {canMore ? (
        <div className="mt-6 flex flex-col items-center gap-2 pb-2">
          <button
            onClick={loadMore}
            disabled={loading}
            className="flex items-center gap-2 rounded-full bg-white/10 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-white/20 active:scale-95 disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </>
            ) : (
              <>
                Show more
                <ChevronDown className="h-4 w-4" />
              </>
            )}
          </button>
          {failed ? (
            <p className="text-xs font-semibold text-red-400">
              Couldn&apos;t load more — tap to retry.
            </p>
          ) : (
            <p className="text-[11px] font-semibold tabular-nums text-white/35">
              #{items.length}
              {totalResults > 0 ? ` of ${totalResults}` : ""} ranked
            </p>
          )}
        </div>
      ) : (
        items.length > PAGE_SIZE && (
          <p className="mt-6 pb-2 text-center text-[11px] font-semibold tabular-nums text-white/35">
            End of list — #{items.length} ranked
          </p>
        )
      )}

      {loading && (
        <div className="mt-4">
          <PosterGridSkeleton count={6} />
        </div>
      )}
    </div>
  );
}
