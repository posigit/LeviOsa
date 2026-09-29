import { cookies } from "next/headers";
import { requireAuth } from "@/lib/auth";
import { db, withDbRetry } from "@/lib/db";
import { movies, userMovies, watchHistory } from "@/lib/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ShowTabs } from "@/components/show-tabs";
import { StickyChrome } from "@/components/sticky-chrome";
import { SectionLabel } from "@/components/section-label";
import { LayoutToggle } from "@/components/layout-toggle";
import { RatingBadge } from "@/components/star-rating";
import { PosterBadges } from "@/components/poster-badges";
import { timed, perfLog, perfStart } from "@/lib/perf";
import { posterUrl, discoverUpcomingMovies } from "@/lib/tmdb";
import { appTodayYmd } from "@/lib/app-time";
import {
  isUnreleased,
  splitWatchNextAndLater,
} from "@/lib/movie-watchlist";
import { getUnseenGreatMoviesPool } from "@/lib/surprise-movies";
import { WatchLaterTools } from "@/components/watch-later-tools";
import {
  LEGACY_LAYOUT_COOKIE,
  layoutCookieName,
  resolveLayoutPref,
} from "@/lib/layout-pref";
import Link from "next/link";
import Image from "next/image";
import { ChevronRight, Clock } from "lucide-react";

function PopcornIllustration() {
  return (
    <div className="relative my-8 flex h-44 w-44 items-center justify-center">
      <div className="absolute inset-0 rounded-full bg-[#8ac249]" />
      <svg
        width="120"
        height="120"
        viewBox="0 0 120 120"
        className="relative z-10"
        aria-hidden
      >
        {/* Bucket */}
        <path
          d="M32 52 L39 100 H81 L88 52 Z"
          fill="#e0202e"
          stroke="#0f0f0f"
          strokeWidth="2"
        />
        <path d="M40 52 L45 100 H55 L52 52 Z" fill="#fff" />
        <path d="M65 52 L68 100 H78 L75 52 Z" fill="#fff" />
        {/* Popcorn */}
        <circle cx="42" cy="42" r="9" fill="#f6e7c8" stroke="#0f0f0f" strokeWidth="2" />
        <circle cx="56" cy="34" r="10" fill="#fdf3dd" stroke="#0f0f0f" strokeWidth="2" />
        <circle cx="70" cy="40" r="9" fill="#f6e7c8" stroke="#0f0f0f" strokeWidth="2" />
        <circle cx="80" cy="48" r="8" fill="#fdf3dd" stroke="#0f0f0f" strokeWidth="2" />
        <circle cx="36" cy="50" r="7" fill="#fdf3dd" stroke="#0f0f0f" strokeWidth="2" />
        <circle cx="62" cy="46" r="8" fill="#f6e7c8" stroke="#0f0f0f" strokeWidth="2" />
        <circle cx="50" cy="48" r="7" fill="#f9edd4" stroke="#0f0f0f" strokeWidth="2" />
      </svg>
      {/* Sparkles */}
      <span className="absolute -left-6 top-6 text-2xl text-[#b455f6]">✦</span>
      <span className="absolute -left-10 top-16 text-xl text-[#7ed321]">✦</span>
      <span className="absolute -right-6 top-8 text-2xl text-[#f5a623]">✦</span>
      <span className="absolute -right-9 bottom-12 text-lg text-[#7ed321]">✕</span>
      <span className="absolute -left-8 bottom-8 text-lg text-[#f5a623]">●</span>
      <span className="absolute -left-4 bottom-16 text-sm text-primary">＋</span>
      <span className="absolute -top-3 right-8 text-lg text-[#b455f6]">●</span>
    </div>
  );
}

function EmptyState({
  title,
  description,
  cta,
  secondaryCta,
}: {
  title: string;
  description: string;
  cta: string;
  secondaryCta?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center pt-16 text-center">
      <h2 className="text-2xl font-bold text-foreground">{title}</h2>
      <PopcornIllustration />
      <p className="mb-8 max-w-xs text-[15px] text-muted-foreground">{description}</p>
      <Link
        href="/explore"
        className="rounded-full bg-primary px-8 py-3.5 text-sm font-black uppercase tracking-wide text-black"
      >
        {cta}
      </Link>
      {secondaryCta && (
        <Link
          href={secondaryCta.href}
          className="mt-2.5 rounded-full px-8 py-3 text-sm font-bold text-muted-foreground ring-1 ring-border transition hover:bg-secondary hover:text-foreground"
        >
          {secondaryCta.label}
        </Link>
      )}
    </div>
  );
}

function MoviePoster({
  title,
  posterPath,
  rating,
  favorite,
  rewatchCount,
  rewatchQueued,
}: {
  title: string;
  posterPath: string | null;
  rating?: number | null;
  favorite?: boolean | null;
  rewatchCount?: number | null;
  rewatchQueued?: boolean | null;
}) {
  return (
    <div style={{ aspectRatio: "2 / 3" }} className="relative w-full bg-secondary">
      <div className="absolute inset-0 overflow-hidden">
        {rating != null && <RatingBadge value={rating} />}
        {posterPath ? (
          <Image
            src={posterUrl(posterPath, "w342") ?? ""}
            alt={title}
            fill
            sizes="(max-width: 768px) 33vw, 200px"
            className="object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[#3a7bd5] p-2 text-center">
            <span className="text-xs font-medium text-white">{title}</span>
          </div>
        )}
      </div>
      <PosterBadges
        favorite={favorite}
        rewatchCount={rewatchCount}
        rewatchQueued={rewatchQueued}
      />
      {rewatchQueued ? (
        <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-primary px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-black">
          Rewatch
        </span>
      ) : null}
    </div>
  );
}

type MovieRow = {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  rating?: number | null;
  releaseDate?: string | null;
  runtime?: number | null;
  rtScore?: number | null;
  favorite?: boolean | null;
  rewatchCount?: number | null;
  rewatchQueued?: boolean | null;
};

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function MovieGrid({ items }: { items: MovieRow[] }) {
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-4">
      {items.map((movie) => (
        <Link
          key={movie.tmdbId}
          href={`/movie/${movie.tmdbId}`}
          className="overflow-visible rounded-md bg-card"
        >
          <div className="overflow-visible rounded-md">
            <div className="overflow-hidden rounded-md">
              <MoviePoster
                title={movie.title}
                posterPath={movie.posterPath}
                rating={movie.rating}
                favorite={movie.favorite}
                rewatchCount={movie.rewatchCount}
                rewatchQueued={movie.rewatchQueued}
              />
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** List row for Watch Next — poster + title meta (matches Shows list vibe). */
function MovieList({ items }: { items: MovieRow[] }) {
  return (
    <div className="space-y-2">
      {items.map((movie) => {
        const poster = posterUrl(movie.posterPath, "w185");
        const year = movie.releaseDate?.slice(0, 4);
        return (
          <Link
            key={movie.tmdbId}
            href={`/movie/${movie.tmdbId}`}
            className="flex items-center gap-3 rounded-xl bg-card p-2.5 active:scale-[0.99]"
          >
            <div className="relative h-[88px] w-[60px] flex-shrink-0 rounded-lg bg-[#2c2c2e]">
              <div className="absolute inset-0 overflow-hidden rounded-lg">
                {poster ? (
                  <Image
                    src={poster}
                    alt={movie.title}
                    fill
                    sizes="60px"
                    className="object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center p-1 text-center text-[9px] text-muted-foreground">
                    {movie.title}
                  </div>
                )}
              </div>
              <PosterBadges
                favorite={movie.favorite}
                rewatchCount={movie.rewatchCount}
                rewatchQueued={movie.rewatchQueued}
                compact
              />
            </div>
            <div className="min-w-0 flex-1 py-0.5">
              <div className="mb-1.5 inline-flex max-w-full items-center gap-0.5 rounded-full border border-foreground/30 px-2.5 py-[3px]">
                <span className="truncate text-[11px] font-bold uppercase tracking-wide text-foreground">
                  {movie.title}
                </span>
                <ChevronRight
                  className="h-3 w-3 flex-shrink-0 text-foreground"
                  strokeWidth={2.5}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] font-semibold text-muted-foreground">
                {year && <span>{year}</span>}
                {movie.runtime != null && movie.runtime > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <Clock className="h-3 w-3" />
                    {formatRuntime(movie.runtime)}
                  </span>
                )}
                {movie.rtScore != null && movie.rtScore >= 0 && (
                  <span className="text-primary">🍅 {movie.rtScore}%</span>
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function formatReleaseDate(releaseDate: string): string {
  return new Date(releaseDate + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Upcoming (unreleased) movie tiles with the release date under the poster. */
function UpcomingMovieGrid({
  items,
}: {
  items: MovieRow[];
}) {
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-4">
      {items.map((movie) => (
        <Link
          key={movie.tmdbId}
          href={`/movie/${movie.tmdbId}`}
          className="overflow-visible rounded-md bg-card"
        >
          <div className="overflow-hidden rounded-md">
            <MoviePoster
              title={movie.title}
              posterPath={movie.posterPath}
              rating={movie.rating}
              favorite={movie.favorite}
              rewatchCount={movie.rewatchCount}
              rewatchQueued={movie.rewatchQueued}
            />
          </div>
          {movie.releaseDate && (
            <p className="px-1.5 py-1.5 text-center text-[10px] font-bold uppercase tracking-wide text-primary">
              {formatReleaseDate(movie.releaseDate)}
            </p>
          )}
        </Link>
      ))}
    </div>
  );
}

/** Theatrical upcoming from TMDB (not in library) with quick add-to-watchlist. */
function DiscoverUpcomingGrid({
  items,
}: {
  items: { tmdbId: number; title: string; posterPath: string | null; releaseDate: string | null }[];
}) {
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-4">
      {items.map((movie) => (
        <div
          key={movie.tmdbId}
          className="relative overflow-visible rounded-md bg-card"
        >
          <Link
            href={`/movie/${movie.tmdbId}`}
            className="block overflow-hidden rounded-md"
          >
            {movie.posterPath ? (
              <div style={{ aspectRatio: "2 / 3" }} className="relative w-full bg-secondary">
                <Image
                  src={posterUrl(movie.posterPath, "w342") ?? ""}
                  alt={movie.title}
                  fill
                  sizes="(max-width: 768px) 33vw, 200px"
                  className="object-cover"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            ) : (
              <div
                style={{ aspectRatio: "2 / 3" }}
                className="flex w-full items-center justify-center bg-secondary p-2 text-center"
              >
                <span className="text-xs font-medium text-muted-foreground">{movie.title}</span>
              </div>
            )}
          </Link>
          {/* Sibling of the Link (never nested): tap the poster to open it. */}
          {movie.releaseDate && (
            <p className="px-1.5 py-1.5 text-center text-[10px] font-bold uppercase tracking-wide text-primary">
              {formatReleaseDate(movie.releaseDate)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Movies — LeviOsa",
  description: "Your movie watchlist, upcoming releases, and theatrical pipeline.",
};

export default async function MoviesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; layout?: string }>;
}) {
  const { view, layout } = await searchParams;
  const currentView = view === "upcoming" ? "upcoming" : "watchlist";
  const cookieStore = await cookies();
  const layoutPref = resolveLayoutPref(
    layout,
    cookieStore.get(layoutCookieName("movies"))?.value,
    cookieStore.get(LEGACY_LAYOUT_COOKIE)?.value
  );
  const gridLayout = layoutPref === "grid";

  const userId = await requireAuth();
  const pageStart = perfStart();

  // userMovies select is tolerant of pre-migration DBs (no rewatch_queued yet).
  let userMoviesList: {
    tmdbId: number;
    title: string;
    posterPath: string | null;
    releaseDate: string | null;
    runtime: number | null;
    rtScore: number | null;
    status: string;
    watchedAt: Date | null;
    rating: number | null;
    favorite: boolean | null;
    rewatchQueued: boolean | null;
    updatedAt: Date;
  }[];
  try {
    userMoviesList = await timed("movies:library", () =>
      withDbRetry(() =>
        db
          .select({
            tmdbId: movies.tmdbId,
            title: movies.title,
            posterPath: movies.posterPath,
            releaseDate: movies.releaseDate,
            runtime: movies.runtime,
            rtScore: movies.rtScore,
            status: userMovies.status,
            watchedAt: userMovies.watchedAt,
            rating: userMovies.rating,
            favorite: userMovies.favorite,
            rewatchQueued: userMovies.rewatchQueued,
            updatedAt: userMovies.updatedAt,
          })
          .from(userMovies)
          .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
          .where(eq(userMovies.userId, userId))
      )
    );
  } catch {
    const fallback = await withDbRetry(() =>
      db
        .select({
          tmdbId: movies.tmdbId,
          title: movies.title,
          posterPath: movies.posterPath,
          releaseDate: movies.releaseDate,
          runtime: movies.runtime,
          rtScore: movies.rtScore,
          status: userMovies.status,
          watchedAt: userMovies.watchedAt,
          rating: userMovies.rating,
          favorite: userMovies.favorite,
          updatedAt: userMovies.updatedAt,
        })
        .from(userMovies)
        .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
        .where(eq(userMovies.userId, userId))
    );
    userMoviesList = fallback.map((m) => ({ ...m, rewatchQueued: false }));
  }

  // Rewatch counts = total watchHistory completions per movie (first + rewatches).
  const rewatchCounts = new Map<number, number>();
  try {
    const watchedIds = userMoviesList
      .filter((m) => m.status === "watched")
      .map((m) => m.tmdbId);
    if (watchedIds.length > 0) {
      const rows = await timed("movies:rewatchCounts", () =>
        withDbRetry(() =>
          db
            .select({
              tmdbId: watchHistory.tmdbId,
              count: sql<number>`count(*)::int`,
            })
            .from(watchHistory)
            .where(
              and(
                eq(watchHistory.userId, userId),
                eq(watchHistory.mediaType, "movie"),
                inArray(watchHistory.tmdbId, watchedIds)
              )
            )
            .groupBy(watchHistory.tmdbId)
        )
      );
      for (const r of rows) rewatchCounts.set(r.tmdbId, Number(r.count));
    }
  } catch {
    // watchHistory may be empty — badges simply hide.
  }
  type MovieLibraryRow = Omit<MovieRow, "releaseDate"> & {
    releaseDate: string | null;
    status: string;
    watchedAt: Date | null;
    updatedAt: Date;
  };
  const withCounts: MovieLibraryRow[] = userMoviesList.map((m) => ({
    ...m,
    rewatchCount: rewatchCounts.get(m.tmdbId) ?? (m.status === "watched" ? 1 : null),
  }));

  // Exclude anything already in the library (watched or listed) from Surprise.
  // Watchlist view only — the upcoming view never reads it (no wasted TMDB call).
  const libraryIds = new Set(withCounts.map((m) => m.tmdbId));
  const surprisePool =
    currentView === "watchlist"
      ? await timed("movies:surprise", () =>
          getUnseenGreatMoviesPool(libraryIds).catch(() => [])
        )
      : [];
  perfLog("movies:totalFetch", pageStart);

  const wantToWatchAll = withCounts.filter(
    (m) => m.status === "want_to_watch" || m.status === "for_later"
  );

  // Queued rewatches surface back in Watch Next (stays watched underneath).
  const queuedRewatches = withCounts.filter(
    (m) => m.status === "watched" && m.rewatchQueued
  );

  // Unreleased → Upcoming tab. Released/undated → Watch Next vs Watch Later.
  const releasedUnwatched = wantToWatchAll.filter((m) => !isUnreleased(m.releaseDate));
  const split = splitWatchNextAndLater(releasedUnwatched);
  const watchNext: MovieRow[] = [...queuedRewatches, ...split.watchNext];
  const watchLater = split.watchLater;

  const upcomingMovies = wantToWatchAll
    .filter((m) => isUnreleased(m.releaseDate))
    .sort((a, b) =>
      (a.releaseDate || "").localeCompare(b.releaseDate || "") ||
      (a.title || "").localeCompare(b.title || "")
    );

  // Real pipeline: TMDB theatrical upcoming (not in library) so the tab is
  // useful even when the watchlist has nothing dated in the future.
  // Best-effort — a TMDB outage must never break the library view.
  let theatricalUpcoming: { tmdbId: number; title: string; posterPath: string | null; releaseDate: string | null }[] = [];
  if (currentView === "upcoming") {
    try {
      // Civil date (app timezone), not UTC — no off-by-one for non-UTC users.
      const today = appTodayYmd();
      const cards = await timed("movies:theatrical", () => discoverUpcomingMovies(today));
      theatricalUpcoming = cards
        .filter((c) => (c.release_date ?? "") >= today && !libraryIds.has(c.id))
        .slice(0, 18)
        .map((c) => ({
          tmdbId: c.id,
          title: c.title,
          posterPath: c.poster_path ?? null,
          releaseDate: c.release_date ?? null,
        }));
    } catch {
      theatricalUpcoming = [];
    }
  }

  // Group upcoming by release month ("DECEMBER 2026")
  const upcomingGroups = new Map<string, typeof upcomingMovies>();
  for (const m of upcomingMovies) {
    const key = new Date(m.releaseDate! + "T12:00:00")
      .toLocaleDateString("en-US", { month: "long", year: "numeric" })
      .toUpperCase();
    const arr = upcomingGroups.get(key);
    if (arr) arr.push(m);
    else upcomingGroups.set(key, [m]);
  }

  const watched = withCounts
    .filter((m) => m.status === "watched")
    .sort((a, b) => (b.watchedAt?.getTime() ?? 0) - (a.watchedAt?.getTime() ?? 0));

  return (
    <div className="min-h-dvh bg-background px-4 pb-nav-page">
      <StickyChrome contentClassName="pt-2">
        <ShowTabs
          tabs={[
            { value: "watchlist", label: "WATCH LIST" },
            { value: "upcoming", label: "UPCOMING" },
          ]}
        />
      </StickyChrome>

      {currentView === "watchlist" && (
        <>
          {watchNext.length > 0 && (
            <section className="mb-6">
              <div className="relative mb-3 mt-2 flex justify-center">
                <SectionLabel>Watch Next</SectionLabel>
                <div className="absolute right-0 top-1/2 -translate-y-1/2">
                  <LayoutToggle scope="movies" initialLayout={layoutPref} />
                </div>
              </div>
              {gridLayout ? (
                <MovieGrid items={watchNext} />
              ) : (
                <MovieList items={watchNext} />
              )}
            </section>
          )}

          {/* Surprise = TMDB top-rated/classics not in library; grid = Watch Later only */}
          {(watchLater.length > 0 || surprisePool.length > 0) && (
            <WatchLaterTools
              items={watchLater.map((m) => ({
                tmdbId: m.tmdbId,
                title: m.title,
                posterPath: m.posterPath,
                releaseDate: m.releaseDate,
                runtime: m.runtime ?? null,
                rtScore: m.rtScore ?? null,
                rating: m.rating ?? null,
              }))}
              surprisePool={surprisePool}
            />
          )}

          {watched.length > 0 && (
            <section className="mb-6">
              <div className="mb-3 flex justify-center">
                <SectionLabel>Recently Watched</SectionLabel>
              </div>
              <MovieGrid items={watched.slice(0, 30)} />
            </section>
          )}

          {withCounts.length === 0 && (
            <EmptyState
              title="Your watch list is empty!"
              description="Add movies you want to watch."
              cta="Browse all movies"
              secondaryCta={{ label: "Import your data", href: "/import" }}
            />
          )}
        </>
      )}

      {currentView === "upcoming" && (
        <>
          {upcomingMovies.length > 0 ? (
            Array.from(upcomingGroups.entries()).map(([label, items]) => (
              <section key={label} className="mb-6">
                <div className="mb-3 mt-2 flex justify-center">
                  <SectionLabel>{label}</SectionLabel>
                </div>
                <UpcomingMovieGrid items={items} />
              </section>
            ))
          ) : theatricalUpcoming.length === 0 ? (
            <EmptyState
              title="Your upcoming list is empty!"
              description="Movies you want to watch that haven't released yet will show up here."
              cta="Browse all movies"
            />
          ) : null}
          {theatricalUpcoming.length > 0 && (
            <section className="mb-6">
              <div className="mb-3 mt-2 flex justify-center">
                <SectionLabel>COMING TO THEATERS</SectionLabel>
              </div>
              <DiscoverUpcomingGrid items={theatricalUpcoming} />
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Tap + to add a release to your watchlist.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
