import type { CSSProperties } from "react";
import { auth, requireAuth } from "@/lib/auth";
import { db, withDbRetry } from "@/lib/db";
import {
  shows,
  movies,
  userShows,
  userMovies,
  watchedEpisodes,
  watchHistory,
  userLists,
} from "@/lib/schema";
import {
  eq,
  and,
  sql,
  count,
  desc,
  gte,
  lt,
  isNotNull,
  inArray,
} from "drizzle-orm";
import { posterUrl, backdropUrl } from "@/lib/tmdb";
import { cn } from "@/lib/utils";
import Link from "next/link";
import Image from "next/image";
import { ChevronRight, Flame, Heart } from "lucide-react";
import { ProfileMenu } from "@/components/profile-menu";
import { ListCreateForm } from "@/components/list-create-form";
import { NotificationToggle } from "@/components/notification-toggle";
import { UserAvatar } from "@/components/user-avatar";
import { ProfileHeatmap } from "@/components/profile-heatmap";
import { ProfileTaste } from "@/components/profile-taste";
import { ProfileYearRecap } from "@/components/profile-year-recap";
import { StarRatingDisplay } from "@/components/star-rating";
import { PosterBadges } from "@/components/poster-badges";
import { ProfilePlaybackShelf } from "@/components/recent-streams";
import { getContinueWatching, getWatchHistory } from "@/lib/playback";
import { timed, perfLog, perfStart } from "@/lib/perf";
import {
  aggregateGenres,
  currentStreak as calcCurrentStreak,
  genresFromTmdbData,
  longestStreak,
  type DayCount,
  type TasteSnapshot,
  type YearRecap,
} from "@/lib/profile-insights";

// Playback and watch-history shelves are user-specific and must be read fresh
// after the player closes or another device updates the account.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Profile — TV Time",
  description: "Your stats, taste, yearly recap, lists, and playback history.",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------- shared bits ----------

function SectionHeader({
  title,
  href,
  heart,
}: {
  title: string;
  href?: string;
  heart?: boolean;
}) {
  const inner = (
    <div className="flex items-center gap-2.5">
      {heart && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#e0202e]">
          <Heart className="h-3.5 w-3.5 fill-white text-white" />
        </span>
      )}
      <h2 className="text-xl font-bold text-foreground">{title}</h2>
    </div>
  );

  if (!href) {
    return <div className="mb-3">{inner}</div>;
  }
  return (
    <Link href={href} className="mb-3 flex items-center justify-between">
      {inner}
      <ChevronRight className="h-5 w-5 text-muted-foreground" />
    </Link>
  );
}

function splitDuration(totalMinutes: number) {
  const months = Math.floor(totalMinutes / (30 * 24 * 60));
  const days = Math.floor((totalMinutes % (30 * 24 * 60)) / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  return { months, days, hours };
}

// ---------- header ----------

function StatCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function BigVal({ value }: { value: number }) {
  return (
    <p className="text-xl font-bold text-foreground">
      {value.toLocaleString("en-US")}
    </p>
  );
}

function DurationCompact({ minutes }: { minutes: number }) {
  const { months, days, hours } = splitDuration(minutes);
  return (
    <p className="text-xl font-bold text-foreground">
      {months > 0 && (
        <>
          {months}
          <span className="text-[11px] font-semibold text-muted-foreground">
            mo{" "}
          </span>
        </>
      )}
      {days}
      <span className="text-[11px] font-semibold text-muted-foreground">d </span>
      {hours}
      <span className="text-[11px] font-semibold text-muted-foreground">h</span>
    </p>
  );
}

// ---------- rails ----------

/**
 * 4-across poster size. Fixed rem sizes (not Tailwind arbitrary calc / 100vw)
 * so flex children always get a real box — collapsed width was zeroing
 * aspect-ratio height and hiding every poster on Recently watched / Top rated.
 * ~84×126 ≈ 4 columns on a 390px phone with page padding + gaps.
 */
const TILE_STYLE: CSSProperties = {
  width: "5.25rem",
  minWidth: "5.25rem",
};

const POSTER_STYLE: CSSProperties = {
  ...TILE_STYLE,
  height: "7.875rem",
  minHeight: "7.875rem",
};

type TileBadges = {
  favorite?: boolean | null;
  rewatchCount?: number | null;
  rewatchQueued?: boolean | null;
};

function PosterTile({
  title,
  posterPath,
  favorite,
  rewatchCount,
  rewatchQueued,
}: {
  title: string;
  posterPath: string | null;
} & TileBadges) {
  const src = posterPath ? posterUrl(posterPath, "w185") : null;
  return (
    <div className="relative" style={POSTER_STYLE}>
      <div
        className="absolute inset-0 overflow-hidden rounded-lg bg-[#2c2c2e]"
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- plain img always paints; next/image fill was collapsing
          <img
            src={src}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[#3a7bd5] p-2 text-center">
            <span className="text-xs font-medium text-white">
              {title || "No title yet"}
            </span>
          </div>
        )}
      </div>
      <PosterBadges
        favorite={favorite}
        rewatchCount={rewatchCount}
        rewatchQueued={rewatchQueued}
      />
    </div>
  );
}

function PosterCarousel({
  items,
  hrefPrefix,
  emptyLabel,
}: {
  items: (
    { tmdbId: number; title: string; posterPath: string | null } & TileBadges
  )[];
  hrefPrefix: string;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item) => (
        <Link
          key={item.tmdbId}
          href={`${hrefPrefix}/${item.tmdbId}`}
          className="block shrink-0"
        >
          <PosterTile
            title={item.title}
            posterPath={item.posterPath}
            favorite={item.favorite}
            rewatchCount={item.rewatchCount}
            rewatchQueued={item.rewatchQueued}
          />
        </Link>
      ))}
    </div>
  );
}

type RailItem = {
  key: string;
  href: string;
  title: string;
  posterPath: string | null;
  sub: string;
  subAccent?: boolean;
  /** Stored 1–10 rating — render as full star row instead of "★ 4.5" text */
  rating?: number | null;
} & TileBadges;

/** Poster rail with a title + caption under each tile (Recently Watched / Top Rated). */
function CaptionedRail({ items }: { items: RailItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item) => (
        <Link key={item.key} href={item.href} className="block shrink-0">
          <PosterTile
            title={item.title}
            posterPath={item.posterPath}
            favorite={item.favorite}
            rewatchCount={item.rewatchCount}
            rewatchQueued={item.rewatchQueued}
          />
          <div style={TILE_STYLE}>
            <p className="mt-1.5 truncate text-xs font-semibold text-foreground">
              {item.title}
            </p>
            {item.rating != null && item.rating > 0 ? (
              <div className="mt-0.5 flex items-center gap-0.5">
                <StarRatingDisplay value={item.rating} size={11} />
              </div>
            ) : (
              <p
                className={cn(
                  "truncate text-[10px] font-medium",
                  item.subAccent ? "text-primary" : "text-muted-foreground"
                )}
              >
                {item.sub}
              </p>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

// ---------- page ----------

export default async function ProfilePage() {
  const pageStart = perfStart();
  const userId = await requireAuth();
  const session = await auth();

  // ----- stats data (one parallel wave — 6 cheap counts share the pool) -----
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    [episodeCount],
    [tvRuntime],
    [moviesWatched],
    [showCount],
    [movieTotal],
    [episodesThisMonth],
  ] = await timed("profile:stats", () =>
    Promise.all([
      timed("profile:stat:episodes", () =>
        db
          .select({ value: count() })
          .from(watchedEpisodes)
          .where(eq(watchedEpisodes.userId, userId))
      ),
      timed("profile:stat:tvRuntime", () =>
        db
          .select({
            value: sql<number>`COALESCE(SUM(${shows.episodeRuntime}), 0)`,
          })
          .from(watchedEpisodes)
          .innerJoin(shows, eq(watchedEpisodes.showTmdbId, shows.tmdbId))
          .where(eq(watchedEpisodes.userId, userId))
      ),
      timed("profile:stat:movies", () =>
        db
          .select({
            value: count(),
            minutes: sql<number>`COALESCE(SUM(${movies.runtime}), 0)`,
          })
          .from(userMovies)
          .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
          .where(
            and(eq(userMovies.userId, userId), eq(userMovies.status, "watched"))
          )
      ),
      timed("profile:stat:shows", () =>
        db
          .select({ value: count() })
          .from(userShows)
          .where(eq(userShows.userId, userId))
      ),
      timed("profile:stat:movieTotal", () =>
        db
          .select({ value: count() })
          .from(userMovies)
          .where(eq(userMovies.userId, userId))
      ),
      timed("profile:stat:month", () =>
        db
          .select({ value: count() })
          .from(watchedEpisodes)
          .where(
            and(
              eq(watchedEpisodes.userId, userId),
              gte(watchedEpisodes.watchedAt, monthStart)
            )
          )
      ),
    ])
  );

  const [continueWatching, recentStreams] = await timed(
    "profile:shelves",
    () =>
      Promise.all([
        withDbRetry(() => getContinueWatching(userId, 10)).catch(() => []),
        withDbRetry(() => getWatchHistory(userId, 30)).catch(() => []),
      ])
  );

  // Activity by day for streak + heatmap. Sourced from the append-only
  // watch_history (every completion keeps its date, rewatches included) UNION
  // current library state (covers pre-history imports). Merged on title-day
  // keys so a completion stamped in both tables counts once, while unwatching
  // (which clears state) can never erase the historical fact of the watch.
  const [histRows, stateMovieRows, stateEpRows] = await timed(
    "profile:activity",
    () =>
      Promise.all([
        db
          .select({
            day: sql<string>`TO_CHAR(${watchHistory.watchedAt}, 'YYYY-MM-DD')`,
            mediaType: watchHistory.mediaType,
            tmdbId: watchHistory.tmdbId,
            seasonNumber: watchHistory.seasonNumber,
            episodeNumber: watchHistory.episodeNumber,
          })
          .from(watchHistory)
          .where(
            and(
              eq(watchHistory.userId, userId),
              isNotNull(watchHistory.watchedAt)
            )
          ),
        db
          .select({
            day: sql<string>`TO_CHAR(${userMovies.watchedAt}, 'YYYY-MM-DD')`,
            tmdbId: userMovies.tmdbId,
          })
          .from(userMovies)
          .where(
            and(
              eq(userMovies.userId, userId),
              eq(userMovies.status, "watched"),
              isNotNull(userMovies.watchedAt)
            )
          ),
        db
          .select({
            day: sql<string>`TO_CHAR(${watchedEpisodes.watchedAt}, 'YYYY-MM-DD')`,
            tmdbId: watchedEpisodes.showTmdbId,
            seasonNumber: watchedEpisodes.seasonNumber,
            episodeNumber: watchedEpisodes.episodeNumber,
          })
          .from(watchedEpisodes)
          .where(
            and(
              eq(watchedEpisodes.userId, userId),
              isNotNull(watchedEpisodes.watchedAt)
            )
          ),
      ])
  );

  const dayTitleSets = new Map<string, Set<string>>();
  const addDayTitle = (
    day: string | null,
    key: string | null
  ) => {
    if (!day || !key) return;
    let set = dayTitleSets.get(day);
    if (!set) {
      set = new Set<string>();
      dayTitleSets.set(day, set);
    }
    set.add(key);
  };
  for (const r of histRows) {
    addDayTitle(
      r.day,
      r.mediaType === "movie"
        ? `movie:${r.tmdbId}`
        : `tv:${r.tmdbId}:${r.seasonNumber ?? 0}:${r.episodeNumber ?? 0}`
    );
  }
  for (const r of stateMovieRows) {
    addDayTitle(r.day, `movie:${r.tmdbId}`);
  }
  for (const r of stateEpRows) {
    addDayTitle(
      r.day,
      `tv:${r.tmdbId}:${r.seasonNumber}:${r.episodeNumber}`
    );
  }

  const dayCountMap = new Map<string, number>();
  for (const [day, titles] of dayTitleSets) {
    dayCountMap.set(day, titles.size);
  }
  const dayCounts: DayCount[] = [...dayCountMap.entries()].map(
    ([day, count]) => ({ day, count })
  );
  const daySet = new Set(dayCountMap.keys());
  const dayStreak = calcCurrentStreak(daySet);
  const bestStreak = longestStreak(daySet);

  // ----- identity -----
  // "Watching since" = earliest watch activity in your data (import included),
  // not the app account creation date (which is often the install year).
  const [[firstEp], [firstMovie]] = await timed("profile:identity", () =>
    Promise.all([
      db
        .select({
          first: sql<string | Date | null>`MIN(${watchedEpisodes.watchedAt})`,
        })
        .from(watchedEpisodes)
        .where(
          and(
            eq(watchedEpisodes.userId, userId),
            isNotNull(watchedEpisodes.watchedAt)
          )
        ),
      db
        .select({
          first: sql<string | Date | null>`MIN(${userMovies.watchedAt})`,
        })
        .from(userMovies)
        .where(
          and(eq(userMovies.userId, userId), isNotNull(userMovies.watchedAt))
        ),
    ])
  );

  const parseActivityDate = (v: string | Date | null | undefined): Date | null => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const epDate = parseActivityDate(firstEp?.first);
  const mvDate = parseActivityDate(firstMovie?.first);
  const sinceDate =
    epDate && mvDate
      ? epDate < mvDate
        ? epDate
        : mvDate
      : (epDate ?? mvDate);

  const since = sinceDate
    ? sinceDate.toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
      })
    : null;

  // ----- recently watched (episodes + movies, merged by recency) -----
  const [recentEpisodes, recentMovies] = await timed("profile:recent", () =>
    Promise.all([
      db
        .select({
          tmdbId: shows.tmdbId,
          title: shows.title,
          posterPath: shows.posterPath,
          backdropPath: shows.backdropPath,
          seasonNumber: watchedEpisodes.seasonNumber,
          episodeNumber: watchedEpisodes.episodeNumber,
          watchedAt: watchedEpisodes.watchedAt,
        })
        .from(watchedEpisodes)
        .innerJoin(shows, eq(watchedEpisodes.showTmdbId, shows.tmdbId))
        .where(
          and(
            eq(watchedEpisodes.userId, userId),
            isNotNull(watchedEpisodes.watchedAt)
          )
        )
        .orderBy(desc(watchedEpisodes.watchedAt))
        // Extra rows so dedupe-by-show still fills ≥4 tiles
        .limit(40),
      db
        .select({
          tmdbId: movies.tmdbId,
          title: movies.title,
          posterPath: movies.posterPath,
          backdropPath: movies.backdropPath,
          releaseDate: movies.releaseDate,
          rating: userMovies.rating,
          favorite: userMovies.favorite,
          watchedAt: userMovies.watchedAt,
        })
        .from(userMovies)
        .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
        .where(
          and(
            eq(userMovies.userId, userId),
            eq(userMovies.status, "watched"),
            isNotNull(userMovies.watchedAt)
          )
        )
        .orderBy(desc(userMovies.watchedAt))
        .limit(20),
    ])
  );

  // Rewatch signals for the movie tiles: total completions + queue flags.
  // Both tolerate pre-migration DBs (missing rewatch_queued / empty history).
  const recentMovieIds = recentMovies.map((m) => m.tmdbId);
  const [movieRewatchCounts, queuedMovieIds] = await timed(
    "profile:recent:badges",
    () =>
      Promise.all([
        (async () => {
          const map = new Map<number, number>();
          if (recentMovieIds.length === 0) return map;
          try {
            const rows = await withDbRetry(() =>
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
                    inArray(watchHistory.tmdbId, recentMovieIds)
                  )
                )
                .groupBy(watchHistory.tmdbId)
            );
            for (const r of rows) map.set(r.tmdbId, Number(r.count));
          } catch {
            /* history unavailable — badges hide */
          }
          return map;
        })(),
        (async () => {
          const set = new Set<number>();
          if (recentMovieIds.length === 0) return set;
          try {
            const rows = await withDbRetry(() =>
              db
                .select({ tmdbId: userMovies.tmdbId })
                .from(userMovies)
                .where(
                  and(
                    eq(userMovies.userId, userId),
                    eq(userMovies.rewatchQueued, true),
                    inArray(userMovies.tmdbId, recentMovieIds)
                  )
                )
            );
            for (const r of rows) set.add(r.tmdbId);
          } catch {
            /* pre-migration — no queue flags */
          }
          return set;
        })(),
      ])
  );

  // One tile per show/movie (latest watch wins) so the rail shows distinct posters.
  type RecentRaw = {
    key: string;
    href: string;
    title: string;
    posterPath: string | null;
    backdropPath: string | null;
    sub: string;
    subAccent: boolean;
    rating?: number | null;
    favorite?: boolean | null;
    rewatchCount?: number | null;
    rewatchQueued?: boolean | null;
    watchedAt: Date | null;
  };
  const recentCandidates: RecentRaw[] = [
    ...recentEpisodes.map((e) => ({
      key: `show-${e.tmdbId}`,
      href: `/show/${e.tmdbId}`,
      title: e.title,
      posterPath: e.posterPath,
      backdropPath: e.backdropPath,
      sub: `S${String(e.seasonNumber).padStart(2, "0")} E${String(e.episodeNumber).padStart(2, "0")}`,
      subAccent: false,
      rating: null as number | null,
      watchedAt: e.watchedAt,
    })),
    ...recentMovies.map((m) => ({
      key: `mv-${m.tmdbId}`,
      href: `/movie/${m.tmdbId}`,
      title: m.title,
      posterPath: m.posterPath,
      backdropPath: m.backdropPath,
      sub: m.rating != null ? "" : "Movie",
      subAccent: m.rating != null,
      rating: m.rating,
      favorite: m.favorite,
      rewatchCount: movieRewatchCounts.get(m.tmdbId) ?? 1,
      rewatchQueued: queuedMovieIds.has(m.tmdbId),
      watchedAt: m.watchedAt,
    })),
  ].sort(
    (a, b) => (b.watchedAt?.getTime() ?? 0) - (a.watchedAt?.getTime() ?? 0)
  );

  const seenRecent = new Set<string>();
  const recentDeduped: RecentRaw[] = [];
  for (const item of recentCandidates) {
    if (seenRecent.has(item.key)) continue;
    seenRecent.add(item.key);
    recentDeduped.push(item);
    if (recentDeduped.length >= 12) break;
  }

  const recentItems: RailItem[] = recentDeduped.map(
    ({ backdropPath: _b, watchedAt: _w, ...item }) => item
  );
  const bannerBackdrop = recentDeduped[0]?.backdropPath ?? null;

  // ----- top rated (movies + shows via derived episode-rating score) -----
  const [topMovies, topShows] = await timed("profile:topRated", () =>
    Promise.all([
      db
        .select({
          tmdbId: movies.tmdbId,
          title: movies.title,
          posterPath: movies.posterPath,
          rating: userMovies.rating,
        })
        .from(userMovies)
        .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
        .where(and(eq(userMovies.userId, userId), isNotNull(userMovies.rating)))
        .orderBy(desc(userMovies.rating))
        .limit(12),
      db
        .select({
          tmdbId: shows.tmdbId,
          title: shows.title,
          posterPath: shows.posterPath,
          avgScore: sql<number>`AVG(${watchedEpisodes.rating})::float`,
          ratedCount: count(),
        })
        .from(watchedEpisodes)
        .innerJoin(shows, eq(watchedEpisodes.showTmdbId, shows.tmdbId))
        .where(
          and(
            eq(watchedEpisodes.userId, userId),
            isNotNull(watchedEpisodes.rating)
          )
        )
        .groupBy(shows.tmdbId, shows.title, shows.posterPath)
        .orderBy(desc(sql`AVG(${watchedEpisodes.rating})`))
        .limit(12),
    ])
  );

  const topRatedItems: RailItem[] = [
    ...topMovies.map((m) => ({
      key: `tm-${m.tmdbId}`,
      href: `/movie/${m.tmdbId}`,
      title: m.title,
      posterPath: m.posterPath,
      score: m.rating ?? 0,
      sub: "",
      rating: m.rating ?? null,
    })),
    ...topShows.map((s) => ({
      key: `ts-${s.tmdbId}`,
      href: `/show/${s.tmdbId}`,
      title: s.title,
      posterPath: s.posterPath,
      score: s.avgScore,
      // Round avg to nearest half-star step (1–10 int scale) for glyph display
      sub: "",
      rating: Math.round(s.avgScore),
    })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ score: _s, ...item }) => ({ ...item, subAccent: true }));

  // ----- Taste snapshot (avg scores + genres from tmdb_data) -----
  const [showRatingAgg, movieRatingAgg, showGenreRows, movieGenreRows] =
    await timed("profile:taste", () =>
      Promise.all([
      db
        .select({
          avg: sql<number>`AVG(${watchedEpisodes.rating})::float`,
          cnt: sql<number>`count(*)::int`,
        })
        .from(watchedEpisodes)
        .where(
          and(
            eq(watchedEpisodes.userId, userId),
            isNotNull(watchedEpisodes.rating)
          )
        )
        .then((r) => r[0]),
      db
        .select({
          avg: sql<number>`AVG(${userMovies.rating})::float`,
          cnt: sql<number>`count(*)::int`,
        })
        .from(userMovies)
        .where(
          and(
            eq(userMovies.userId, userId),
            isNotNull(userMovies.rating)
          )
        )
        .then((r) => r[0]),
      // Genres weighted by rated episodes per show
      db
        .select({
          tmdbData: shows.tmdbData,
          scoreSum: sql<number>`COALESCE(SUM(${watchedEpisodes.rating}), 0)::float`,
          scoreCount: sql<number>`count(${watchedEpisodes.rating})::int`,
          weight: sql<number>`count(*)::int`,
        })
        .from(watchedEpisodes)
        .innerJoin(shows, eq(watchedEpisodes.showTmdbId, shows.tmdbId))
        .where(eq(watchedEpisodes.userId, userId))
        .groupBy(shows.tmdbId, shows.tmdbData),
      db
        .select({
          tmdbData: movies.tmdbData,
          rating: userMovies.rating,
        })
        .from(userMovies)
        .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
        .where(
          and(
            eq(userMovies.userId, userId),
            eq(userMovies.status, "watched")
          )
        ),
      ])
    );

  const taste: TasteSnapshot = {
    avgShowScore: showRatingAgg?.avg ?? null,
    avgMovieScore: movieRatingAgg?.avg ?? null,
    ratedEpisodes: showRatingAgg?.cnt ?? 0,
    ratedMovies: movieRatingAgg?.cnt ?? 0,
    genres: aggregateGenres([
      ...showGenreRows.map((r) => ({
        genres: genresFromTmdbData(r.tmdbData),
        weight: Number(r.weight) || 1,
        scoreSum: Number(r.scoreSum) || 0,
        scoreCount: Number(r.scoreCount) || 0,
      })),
      ...movieGenreRows.map((r) => ({
        genres: genresFromTmdbData(r.tmdbData),
        weight: 1,
        scoreSum: r.rating != null ? Number(r.rating) : 0,
        scoreCount: r.rating != null ? 1 : 0,
      })),
    ]),
    topTitles: topRatedItems.slice(0, 8).map((t) => ({
      key: t.key,
      href: t.href,
      title: t.title,
      posterPath: t.posterPath,
      scoreLabel: t.sub.split(" · ")[0] || t.sub,
    })),
  };

  // ----- Year recap (calendar year) -----
  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);

  const [yearEpStats, yearMovieStats, yearShowCandidates, yearTopMovieRows] =
    await timed("profile:year", () =>
    Promise.all([
      db
        .select({
          episodes: sql<number>`count(*)::int`,
          minutes: sql<number>`COALESCE(SUM(${shows.episodeRuntime}), 0)::int`,
        })
      .from(watchedEpisodes)
      .innerJoin(shows, eq(watchedEpisodes.showTmdbId, shows.tmdbId))
      .where(
        and(
          eq(watchedEpisodes.userId, userId),
          isNotNull(watchedEpisodes.watchedAt),
          gte(watchedEpisodes.watchedAt, yearStart),
          lt(watchedEpisodes.watchedAt, yearEnd)
        )
      )
      .then((r) => r[0]),
    db
      .select({
        movies: sql<number>`count(*)::int`,
        minutes: sql<number>`COALESCE(SUM(${movies.runtime}), 0)::int`,
      })
      .from(userMovies)
      .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
      .where(
        and(
          eq(userMovies.userId, userId),
          eq(userMovies.status, "watched"),
          isNotNull(userMovies.watchedAt),
          gte(userMovies.watchedAt, yearStart),
          lt(userMovies.watchedAt, yearEnd)
        )
      )
      .then((r) => r[0]),
    // Per-show year totals + time span (for bulk-import demotion).
    // Also carries tmdbData so the year-genre breakdown reuses this one
    // scan instead of running a second GROUP BY over the same rows.
    db
      .select({
        title: shows.title,
        posterPath: shows.posterPath,
        tmdbData: shows.tmdbData,
        episodes: sql<number>`count(*)::int`,
        days: sql<number>`count(DISTINCT TO_CHAR(${watchedEpisodes.watchedAt}, 'YYYY-MM-DD'))::int`,
        spanSec: sql<number>`EXTRACT(EPOCH FROM (max(${watchedEpisodes.watchedAt}) - min(${watchedEpisodes.watchedAt})))::float`,
      })
      .from(watchedEpisodes)
      .innerJoin(shows, eq(watchedEpisodes.showTmdbId, shows.tmdbId))
      .where(
        and(
          eq(watchedEpisodes.userId, userId),
          isNotNull(watchedEpisodes.watchedAt),
          gte(watchedEpisodes.watchedAt, yearStart),
          lt(watchedEpisodes.watchedAt, yearEnd)
        )
      )
      .groupBy(shows.tmdbId, shows.title, shows.posterPath, shows.tmdbData),
    // Highest-rated movie watched this year (must have a rating)
    db
      .select({
        title: movies.title,
        posterPath: movies.posterPath,
        rating: userMovies.rating,
      })
      .from(userMovies)
      .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
      .where(
        and(
          eq(userMovies.userId, userId),
          eq(userMovies.status, "watched"),
          isNotNull(userMovies.watchedAt),
          isNotNull(userMovies.rating),
          gte(userMovies.watchedAt, yearStart),
          lt(userMovies.watchedAt, yearEnd)
        )
      )
      .orderBy(desc(userMovies.rating), desc(userMovies.watchedAt))
      .limit(1),
    ])
  );

  // Year-genre weights reuse the per-show scan above (episodes == row count).
  const yearShowGenreRows = yearShowCandidates.map((s) => ({
    tmdbData: s.tmdbData,
    weight: s.episodes,
  }));

  // Most watched = highest episode count this year.
  // Only demote pure bulk dumps (many eps, single day, all within ~30s) so
  // import stamps like "114 Flash in one second" don't win over real binges.
  const yearShowRanked = [...yearShowCandidates].map((s) => {
    const eps = Number(s.episodes);
    const days = Number(s.days);
    const span = Number(s.spanSec) || 0;
    const isBulk = eps >= 5 && days <= 1 && span <= 30;
    return {
      title: s.title,
      posterPath: s.posterPath,
      episodes: eps,
      isBulk,
    };
  });
  const nonBulk = yearShowRanked.filter((s) => !s.isBulk);
  const yearTopShowRows = (
    nonBulk.length > 0 ? nonBulk : yearShowRanked
  )
    .sort((a, b) => b.episodes - a.episodes)
    .slice(0, 1);

  const yearActiveDays = [...dayCountMap.keys()].filter((d) => {
    const y = Number(d.slice(0, 4));
    return y === year;
  }).length;

  const yearGenres = aggregateGenres(
    yearShowGenreRows.map((r) => ({
      genres: genresFromTmdbData(r.tmdbData),
      weight: Number(r.weight) || 1,
      scoreSum: 0,
      scoreCount: 0,
    }))
  );

  const yearRecap: YearRecap = {
    year,
    episodes: yearEpStats?.episodes ?? 0,
    movies: yearMovieStats?.movies ?? 0,
    tvMinutes: yearEpStats?.minutes ?? 0,
    movieMinutes: yearMovieStats?.minutes ?? 0,
    activeDays: yearActiveDays,
    topShow: yearTopShowRows[0]
      ? {
          title: yearTopShowRows[0].title,
          posterPath: yearTopShowRows[0].posterPath,
          episodes: Number(yearTopShowRows[0].episodes),
        }
      : null,
    topMovie: yearTopMovieRows[0]
      ? {
          title: yearTopMovieRows[0].title,
          posterPath: yearTopMovieRows[0].posterPath,
          rating: yearTopMovieRows[0].rating,
        }
      : null,
    topGenre: yearGenres[0]?.name ?? null,
  };

  // ----- library carousels -----
  // Favorites must be their own queries. Filtering favorites out of a
  // limit(20) "recently updated" slice leaves the rails empty whenever
  // favorites aren't among the 20 most-recently-touched library rows.
  const [allShows, favoriteShows, allMovies, favoriteMovies, lists] =
    await timed("profile:rails", () =>
      Promise.all([
      db
        .select({
          tmdbId: shows.tmdbId,
          title: shows.title,
          posterPath: shows.posterPath,
        })
        .from(userShows)
        .innerJoin(shows, eq(userShows.tmdbId, shows.tmdbId))
        .where(eq(userShows.userId, userId))
        .orderBy(desc(userShows.updatedAt))
        .limit(20),
      db
        .select({
          tmdbId: shows.tmdbId,
          title: shows.title,
          posterPath: shows.posterPath,
        })
        .from(userShows)
        .innerJoin(shows, eq(userShows.tmdbId, shows.tmdbId))
        .where(and(eq(userShows.userId, userId), eq(userShows.favorite, true)))
        .orderBy(desc(userShows.updatedAt))
        .limit(20),
      db
        .select({
          tmdbId: movies.tmdbId,
          title: movies.title,
          posterPath: movies.posterPath,
          favorite: userMovies.favorite,
        })
        .from(userMovies)
        .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
        .where(eq(userMovies.userId, userId))
        .orderBy(desc(userMovies.updatedAt))
        .limit(20),
      db
        .select({
          tmdbId: movies.tmdbId,
          title: movies.title,
          posterPath: movies.posterPath,
          favorite: userMovies.favorite,
        })
        .from(userMovies)
        .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
        .where(
          and(eq(userMovies.userId, userId), eq(userMovies.favorite, true))
        )
        .orderBy(desc(userMovies.updatedAt))
        .limit(20),
        db.select().from(userLists).where(eq(userLists.userId, userId)),
      ])
    );

  // Rewatch badges for the Movies / Favorite-movies rails.
  const railMovieIds = [
    ...new Set([...allMovies, ...favoriteMovies].map((m) => m.tmdbId)),
  ];
  const railRewatchCounts = new Map<number, number>();
  const railQueued = new Set<number>();
  await timed("profile:rails:badges", async () => {
  if (railMovieIds.length > 0) {
    try {
      const rows = await withDbRetry(() =>
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
              inArray(watchHistory.tmdbId, railMovieIds)
            )
          )
          .groupBy(watchHistory.tmdbId)
      );
      for (const r of rows) railRewatchCounts.set(r.tmdbId, Number(r.count));
    } catch {
      /* badges hide */
    }
    try {
      const rows = await withDbRetry(() =>
        db
          .select({ tmdbId: userMovies.tmdbId })
          .from(userMovies)
          .where(
            and(
              eq(userMovies.userId, userId),
              eq(userMovies.rewatchQueued, true),
              inArray(userMovies.tmdbId, railMovieIds)
            )
          )
      );
      for (const r of rows) railQueued.add(r.tmdbId);
    } catch {
      /* pre-migration */
    }
  }
  });
  const withRailBadges = <
    T extends { tmdbId: number; favorite?: boolean | null },
  >(
    items: T[]
  ) =>
    items.map((m) => ({
      ...m,
      favorite: m.favorite ?? undefined,
      rewatchCount: railRewatchCounts.get(m.tmdbId) ?? null,
      rewatchQueued: railQueued.has(m.tmdbId),
    }));
  const allMoviesBadged = withRailBadges(allMovies);
  const favoriteMoviesBadged = withRailBadges(
    favoriteMovies.map((m) => ({ ...m, favorite: true }))
  );

  // Resolve up to 4 poster previews per list so the Lists section isn't blank text.
  // New shapes carry their own posterPath (used first); legacy refs fall back
  // to the library tables.
  type ListItemRef = {
    tmdbId?: number;
    type?: string;
    mediaType?: string;
    posterPath?: string | null;
  };
  const storedPosterByKey = new Map<string, string>();
  const listPreviewIds = {
    movie: new Set<number>(),
    tv: new Set<number>(),
  };
  for (const list of lists) {
    const items = (Array.isArray(list.items) ? list.items : []) as ListItemRef[];
    for (const item of items.slice(0, 4)) {
      if (!Number.isFinite(item?.tmdbId)) continue;
      if (typeof item.posterPath === "string" && item.posterPath) {
        const mt = item.mediaType === "movie" ? "movie" : "tv";
        storedPosterByKey.set(`${mt}:${item.tmdbId}`, item.posterPath);
        continue;
      }
      if (item.type === "movie" || list.type === "favorite_movies") {
        listPreviewIds.movie.add(item.tmdbId!);
      } else {
        listPreviewIds.tv.add(item.tmdbId!);
      }
    }
  }

  const moviePreviewIds = [...listPreviewIds.movie];
  const showPreviewIds = [...listPreviewIds.tv];
  const [listMoviePosters, listShowPosters] = await timed(
    "profile:lists",
    () =>
      Promise.all([
        moviePreviewIds.length > 0
          ? db
              .select({ tmdbId: movies.tmdbId, posterPath: movies.posterPath })
              .from(movies)
              .where(inArray(movies.tmdbId, moviePreviewIds))
          : Promise.resolve(
              [] as { tmdbId: number; posterPath: string | null }[]
            ),
        showPreviewIds.length > 0
          ? db
              .select({ tmdbId: shows.tmdbId, posterPath: shows.posterPath })
              .from(shows)
              .where(inArray(shows.tmdbId, showPreviewIds))
          : Promise.resolve(
              [] as { tmdbId: number; posterPath: string | null }[]
            ),
      ])
  );

  const posterByMovie = new Map(
    listMoviePosters.map((m) => [m.tmdbId, m.posterPath])
  );
  const posterByShow = new Map(
    listShowPosters.map((s) => [s.tmdbId, s.posterPath])
  );

  const listHref = (type: string, id: string) => {
    if (type === "favorite_movies") return "/profile/list/favorite-movies";
    if (type === "favorite_shows") return "/profile/list/favorite-shows";
    if (type === "custom") return `/profile/list/custom/${id}`;
    return null;
  };

  const listsWithPreviews = lists.map((list) => {
    const items = (Array.isArray(list.items) ? list.items : []) as ListItemRef[];
    const previews = items.slice(0, 4).map((item) => {
      const id = Number(item?.tmdbId);
      if (!Number.isFinite(id)) return null;
      const isMovie =
        item.mediaType === "movie" ||
        item.type === "movie" ||
        list.type === "favorite_movies";
      const mt = isMovie ? "movie" : "tv";
      return (
        storedPosterByKey.get(`${mt}:${id}`) ??
        (isMovie ? posterByMovie.get(id) : posterByShow.get(id)) ??
        null
      );
    });
    return {
      id: list.id,
      name: list.name,
      type: list.type,
      count: items.length,
      href: listHref(list.type, list.id),
      previews,
    };
  });

  const rawName = session?.user?.name?.trim() || "User";
  const name =
    rawName.length > 0
      ? rawName.charAt(0).toUpperCase() + rawName.slice(1)
      : "User";

  // Only the admin keeps the branded photo; everyone else gets an initials disc.
  const adminUsername = process.env.ADMIN_USERNAME || "posi";
  const isAdmin =
    name.toLowerCase() === adminUsername.toLowerCase();

  perfLog("profile:totalFetch", pageStart);

  return (
    <div className="min-h-dvh bg-background pb-nav-page">
      {/*
        Hero + identity in one relative stack so the avatar can overlap the
        banner without being clipped by overflow-hidden on the image box.
        (On iPhone that clipping was cutting the avatar in half and eating the name.)
      */}
      <div className="relative mb-6">
        <div className="relative h-profile-hero w-full overflow-hidden">
          {bannerBackdrop ? (
            <Image
              src={backdropUrl(bannerBackdrop, "w1280") ?? ""}
              alt=""
              fill
              sizes="100vw"
              className="object-cover"
              unoptimized
              priority
            />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-primary/40 via-[#1c1c1e] to-black" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-black/20" />
        </div>
        {/* Hosted OUTSIDE the overflow-hidden hero so the dropdown is never clipped. */}
        <div className="absolute right-3 top-safe-float z-20">
          <ProfileMenu />
        </div>

        {/* Sits on top of the banner edge — outside the overflow-hidden image box */}
        <div className="relative z-10 -mt-12 flex items-end gap-3 px-4">
          <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-full shadow-lg ring-4 ring-black">
            <UserAvatar
              name={name}
              photo={isAdmin ? "/avatars/profile.jpg" : null}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="truncate text-2xl font-bold leading-tight text-white drop-shadow-sm">
              {name}
            </h1>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {since ? (
                <>
                  Watching since {since}
                  <span className="text-muted-foreground/50"> · </span>
                </>
              ) : null}
              {showCount?.value ?? 0} shows
              <span className="text-muted-foreground/50"> · </span>
              {movieTotal?.value ?? 0} movies
            </p>
          </div>
        </div>
      </div>

      <div className="px-4">
        <ProfilePlaybackShelf
          continueItems={continueWatching}
          recentItems={recentStreams}
        />

        {/* ---------- New-episode push alerts ---------- */}
        <section className="mb-8">
          <SectionHeader title="Notifications" />
          <NotificationToggle />
        </section>

        {/* ---------- Stats (one consolidated card) ---------- */}
        <section className="mb-8">
          <SectionHeader title="Stats" />
          <div className="rounded-2xl bg-card p-4">
            <div className="grid grid-cols-2 gap-x-3 gap-y-5">
              <StatCell label="Day streak">
                <p className="flex items-center gap-1.5 text-xl font-bold text-foreground">
                  <Flame
                    className={cn(
                      "h-5 w-5",
                      dayStreak > 0
                        ? "text-[#f5a623]"
                        : "text-muted-foreground"
                    )}
                    fill="currentColor"
                  />
                  {dayStreak}
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    {dayStreak === 1 ? "day" : "days"}
                    {bestStreak > dayStreak ? ` · best ${bestStreak}` : ""}
                  </span>
                </p>
              </StatCell>
              <StatCell label="Episodes this month">
                <BigVal value={episodesThisMonth?.value || 0} />
              </StatCell>
              <StatCell label="Time watching TV">
                <DurationCompact minutes={tvRuntime?.value || 0} />
              </StatCell>
              <StatCell label="Episodes watched">
                <BigVal value={episodeCount?.value || 0} />
              </StatCell>
              <StatCell label="Time watching movies">
                <DurationCompact minutes={moviesWatched?.minutes || 0} />
              </StatCell>
              <StatCell label="Movies watched">
                <BigVal value={moviesWatched?.value || 0} />
              </StatCell>
            </div>
          </div>
        </section>

        {/* ---------- Year in review ---------- */}
        <section className="mb-8">
          <SectionHeader title={`${year} so far`} />
          <ProfileYearRecap recap={yearRecap} />
        </section>

        {/* ---------- Watch heatmap ---------- */}
        <section className="mb-8">
          <SectionHeader title="Activity" />
          <ProfileHeatmap
            dayCounts={dayCounts}
            currentStreak={dayStreak}
            longestStreak={bestStreak}
          />
        </section>

        {/* ---------- Taste snapshot ---------- */}
        <section className="mb-8">
          <SectionHeader title="Your taste" />
          <ProfileTaste taste={taste} />
        </section>

        {/* ---------- Recently watched ---------- */}
        {recentItems.length > 0 && (
          <section className="mb-8">
            <SectionHeader title="Recently watched" />
            <CaptionedRail items={recentItems} />
          </section>
        )}

        {/* ---------- Top rated ---------- */}
        {topRatedItems.length > 0 && (
          <section className="mb-8">
            <SectionHeader title="Top rated" />
            <CaptionedRail items={topRatedItems} />
          </section>
        )}

        {/* ---------- Lists ---------- */}
        <section className="mb-8">
          <SectionHeader title="Lists" />
          {listsWithPreviews.length > 0 ? (
            <div className="space-y-2">
              {listsWithPreviews.map((list) => {
                const body = (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="font-medium text-foreground">{list.name}</p>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <span className="text-xs">
                          {list.count} item{list.count === 1 ? "" : "s"}
                        </span>
                        {list.href && <ChevronRight className="h-4 w-4" />}
                      </div>
                    </div>
                    {list.previews.some(Boolean) ? (
                      <div className="flex gap-1.5">
                        {list.previews.map((path, i) => {
                          const src = path ? posterUrl(path, "w92") : null;
                          return (
                            <div
                              key={i}
                              className="relative h-[4.5rem] w-12 shrink-0 overflow-hidden rounded-md bg-[#2c2c2e]"
                            >
                              {src ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={src}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                />
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </>
                );

                return list.href ? (
                  <Link
                    key={list.id}
                    href={list.href}
                    className="block rounded-xl bg-card p-4"
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={list.id} className="rounded-xl bg-card p-4">
                    {body}
                  </div>
                );
              })}
              <ListCreateForm compact />
            </div>
          ) : (
            <ListCreateForm />
          )}
        </section>

        {/* ---------- Library rails ---------- */}
        <section className="mb-8">
          <SectionHeader title="Shows" href="/profile/list/shows" />
          <PosterCarousel
            items={allShows}
            hrefPrefix="/show"
            emptyLabel="No shows yet. Explore to follow some."
          />
        </section>

        <section className="mb-8">
          <SectionHeader
            title="Favorite shows"
            href="/profile/list/favorite-shows"
            heart
          />
          <PosterCarousel
            items={favoriteShows}
            hrefPrefix="/show"
            emptyLabel="No favorite shows yet"
          />
        </section>

        <section className="mb-8">
          <SectionHeader title="Movies" href="/profile/list/movies" />
          <PosterCarousel
            items={allMoviesBadged}
            hrefPrefix="/movie"
            emptyLabel="No movies yet. Add some from Explore."
          />
        </section>

        <section className="mb-8">
          <SectionHeader
            title="Favorite movies"
            href="/profile/list/favorite-movies"
            heart
          />
          <PosterCarousel
            items={favoriteMoviesBadged}
            hrefPrefix="/movie"
            emptyLabel="No favorite movies yet"
          />
        </section>
      </div>
    </div>
  );
}
