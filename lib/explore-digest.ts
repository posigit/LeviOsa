import { db, withDbRetry } from "./db";
import {
  movies,
  shows,
  userExploreDigest,
  userMovies,
  userShows,
  watchedEpisodes,
} from "./schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { appTodayYmd } from "./app-time";
import {
  aggregateGenres,
  genresFromTmdbData,
} from "./profile-insights";
import {
  filterNewMedia,
  getBecauseYouWatched,
  pickRotated,
  rotationOffset,
  type BecauseRail,
} from "./recommend";
import { cachedGenreList } from "./tmdb-list-cache";
import {
  getMovieRecommendations,
  getMovieVideos,
  getTvRecommendations,
  getTvVideos,
  getMovieDetails,
  getTvDetails,
  pickTrailerKey,
  MOVIE_GENRES,
  TV_GENRES,
  type TmdbMediaCard,
} from "./tmdb";

export type { BecauseRail };

export type DailyPick = {
  item: TmdbMediaCard;
  reason: string;
  trailerKey: string | null;
};

export type ExploreDigest = {
  day: string;
  dailyPick: DailyPick | null;
  forYou: TmdbMediaCard[];
  because: BecauseRail[];
};

const FOR_YOU_LIMIT = 16;
const BECAUSE_ITEM_LIMIT = 14;

export function mediaKey(item: Pick<TmdbMediaCard, "mediaType" | "id">) {
  return `${item.mediaType}:${item.id}`;
}

export function interleaveBuckets<T>(buckets: T[][], limit: number): T[] {
  const out: T[] = [];
  let i = 0;
  while (out.length < limit) {
    let added = false;
    for (const bucket of buckets) {
      if (i < bucket.length) {
        out.push(bucket[i]);
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break;
    i++;
  }
  return out;
}

export function pickDailyPick(items: TmdbMediaCard[]): TmdbMediaCard | null {
  if (items.length === 0) return null;
  const withArt = items.find(
    (item) => item.backdrop_path || item.overview || item.poster_path
  );
  return withArt ?? items[0];
}

export function dailyPickReason(opts: {
  seedTitle?: string | null;
  genre?: string | null;
}): string {
  if (opts.seedTitle) return `Because you watched ${opts.seedTitle}`;
  if (opts.genre) return `You watch a lot of ${opts.genre}`;
  return "Picked for you today";
}

export function genreIdForName(
  name: string,
  kind: "tv" | "movie"
): number | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const list = kind === "tv" ? TV_GENRES : MOVIE_GENRES;
  const hit = list.find((g) => g.name.toLowerCase() === needle);
  if (hit) return hit.id;
  const aliases: Record<string, { tv?: number; movie?: number }> = {
    "sci-fi": { tv: 10765, movie: 878 },
    "science fiction": { tv: 10765, movie: 878 },
    "sci-fi & fantasy": { tv: 10765, movie: 878 },
    fantasy: { tv: 10765, movie: 14 },
    action: { tv: 10759, movie: 28 },
    "action & adventure": { tv: 10759, movie: 28 },
    adventure: { tv: 10759, movie: 12 },
    thriller: { movie: 53 },
    horror: { movie: 27 },
    animation: { tv: 16, movie: 16 },
    crime: { tv: 80, movie: 80 },
    drama: { tv: 18, movie: 18 },
    comedy: { tv: 35, movie: 35 },
  };
  return aliases[needle]?.[kind] ?? null;
}

export function orderGenreChips<T extends { label: string }>(
  chips: T[],
  tasteNames: string[]
): T[] {
  if (tasteNames.length === 0) return chips;
  const rank = new Map(
    tasteNames.map((n, i) => [n.trim().toLowerCase(), i] as const)
  );
  return [...chips].sort((a, b) => {
    const al = a.label.toLowerCase();
    const bl = b.label.toLowerCase();
    const ar = bestChipRank(al, rank);
    const br = bestChipRank(bl, rank);
    return ar - br;
  });
}

function bestChipRank(label: string, rank: Map<string, number>) {
  let best = 999;
  for (const [name, i] of rank) {
    if (label.includes(name) && i < best) best = i;
  }
  return best;
}

function parseDailyPick(raw: unknown): DailyPick | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    item?: TmdbMediaCard;
    reason?: string;
    trailerKey?: string | null;
  };
  if (!row.item?.id || !row.item.title) return null;
  return {
    item: row.item,
    reason: row.reason || "Picked for you today",
    trailerKey: row.trailerKey ?? null,
  };
}

function parseBecause(raw: unknown): BecauseRail[] {
  if (!Array.isArray(raw)) return [];
  const out: BecauseRail[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as {
      seedTitle?: unknown;
      seedTmdbId?: unknown;
      items?: unknown;
    };
    if (typeof row.seedTitle !== "string" || !Array.isArray(row.items)) continue;
    out.push({
      seedTitle: row.seedTitle,
      seedTmdbId:
        typeof row.seedTmdbId === "number" && Number.isFinite(row.seedTmdbId)
          ? row.seedTmdbId
          : 0,
      items: row.items as BecauseRail["items"],
    });
    if (out.length >= 2) break;
  }
  return out;
}

function parseCards(raw: unknown): TmdbMediaCard[] {
  return Array.isArray(raw) ? (raw as TmdbMediaCard[]) : [];
}

async function loadLibrary(userId: string) {
  const [followedShows, followedMovies] = await Promise.all([
    withDbRetry(() =>
      db
        .select({ tmdbId: userShows.tmdbId })
        .from(userShows)
        .where(eq(userShows.userId, userId))
    ),
    withDbRetry(() =>
      db
        .select({ tmdbId: userMovies.tmdbId, status: userMovies.status })
        .from(userMovies)
        .where(eq(userMovies.userId, userId))
    ),
  ]);
  return {
    showIds: new Set(followedShows.map((s) => s.tmdbId)),
    movieIds: new Set(followedMovies.map((m) => m.tmdbId)),
    movieStatusById: new Map(
      followedMovies.map((m) => [m.tmdbId, m.status] as const)
    ),
  };
}

async function loadTasteGenres(userId: string): Promise<string[]> {
  const [showRows, movieRows] = await Promise.all([
    withDbRetry(() =>
      db
        .select({ tmdbData: shows.tmdbData })
        .from(userShows)
        .innerJoin(shows, eq(shows.tmdbId, userShows.tmdbId))
        .where(eq(userShows.userId, userId))
        .limit(80)
    ),
    withDbRetry(() =>
      db
        .select({ tmdbData: movies.tmdbData })
        .from(userMovies)
        .innerJoin(movies, eq(movies.tmdbId, userMovies.tmdbId))
        .where(
          and(eq(userMovies.userId, userId), eq(userMovies.status, "watched"))
        )
        .limit(80)
    ),
  ]);
  const stats = aggregateGenres(
    [...showRows, ...movieRows].map((row) => ({
      genres: genresFromTmdbData(row.tmdbData),
      weight: 1,
      scoreSum: 0,
      scoreCount: 0,
    }))
  );
  return stats.map((g) => g.name);
}

async function enrichPick(item: TmdbMediaCard): Promise<TmdbMediaCard> {
  try {
    if (item.mediaType === "tv") {
      const d = await getTvDetails(item.id);
      return {
        ...item,
        title: d.name || item.title,
        poster_path: d.poster_path ?? item.poster_path,
        backdrop_path: d.backdrop_path ?? item.backdrop_path,
        overview: d.overview ?? item.overview,
        vote_average: d.vote_average ?? item.vote_average,
      };
    }
    const d = await getMovieDetails(item.id);
    return {
      ...item,
      title: d.title || item.title,
      poster_path: d.poster_path ?? item.poster_path,
      backdrop_path: d.backdrop_path ?? item.backdrop_path,
      overview: d.overview ?? item.overview,
      vote_average: d.vote_average ?? item.vote_average,
    };
  } catch {
    return item;
  }
}

async function pickTrailer(item: TmdbMediaCard): Promise<string | null> {
  try {
    const videos =
      item.mediaType === "tv"
        ? await getTvVideos(item.id)
        : await getMovieVideos(item.id);
    return pickTrailerKey(videos);
  } catch {
    return null;
  }
}

async function genreRails(
  tasteNames: string[],
  showIds: Set<number>,
  movieIds: Set<number>
): Promise<TmdbMediaCard[][]> {
  const buckets: TmdbMediaCard[][] = [];
  let tvUsed = false;
  let movieUsed = false;
  for (const name of tasteNames.slice(0, 4)) {
    if (!tvUsed) {
      const id = genreIdForName(name, "tv");
      if (id) {
        const items = filterNewMedia(
          await cachedGenreList("tv", id).catch(() => []),
          showIds,
          12
        );
        if (items.length) {
          buckets.push(items);
          tvUsed = true;
        }
      }
    }
    if (!movieUsed) {
      const id = genreIdForName(name, "movie");
      if (id) {
        const items = filterNewMedia(
          await cachedGenreList("movie", id).catch(() => []),
          movieIds,
          12
        );
        if (items.length) {
          buckets.push(items);
          movieUsed = true;
        }
      }
    }
    if (tvUsed && movieUsed) break;
  }
  return buckets;
}

async function extraRecBuckets(
  userId: string,
  showIds: Set<number>,
  movieIds: Set<number>
): Promise<TmdbMediaCard[][]> {
  const [showSeeds, movieSeeds] = await Promise.all([
    withDbRetry(() =>
      db
        .select({
          tmdbId: watchedEpisodes.showTmdbId,
          title: shows.title,
        })
        .from(watchedEpisodes)
        .innerJoin(shows, eq(shows.tmdbId, watchedEpisodes.showTmdbId))
        .where(eq(watchedEpisodes.userId, userId))
        .groupBy(watchedEpisodes.showTmdbId, shows.title)
        .orderBy(desc(sql`count(*)`))
        .limit(6)
    ),
    withDbRetry(() =>
      db
        .select({
          tmdbId: userMovies.tmdbId,
          title: movies.title,
        })
        .from(userMovies)
        .innerJoin(movies, eq(movies.tmdbId, userMovies.tmdbId))
        .where(
          and(eq(userMovies.userId, userId), eq(userMovies.status, "watched"))
        )
        .orderBy(desc(userMovies.watchedAt))
        .limit(4)
    ),
  ]);

  const buckets: TmdbMediaCard[][] = [];
  const showPicks = showSeeds.slice(0, 2);
  const moviePicks = movieSeeds.slice(0, 1);

  for (const seed of showPicks) {
    try {
      const items = filterNewMedia(
        await getTvRecommendations(seed.tmdbId),
        showIds,
        10
      );
      if (items.length) buckets.push(items);
    } catch {
      /* skip */
    }
  }
  for (const seed of moviePicks) {
    try {
      const items = filterNewMedia(
        await getMovieRecommendations(seed.tmdbId),
        movieIds,
        10
      );
      if (items.length) buckets.push(items);
    } catch {
      /* skip */
    }
  }
  return buckets;
}

async function buildDigest(
  userId: string,
  day: string,
  opts?: { excludeSeedIds?: number[]; excludeSeedTitles?: string[] }
): Promise<ExploreDigest> {
  const { showIds, movieIds } = await loadLibrary(userId);
  const [because, tasteNames] = await Promise.all([
    getBecauseYouWatched(userId, BECAUSE_ITEM_LIMIT, {
      excludeSeedIds: opts?.excludeSeedIds,
      excludeSeedTitles: opts?.excludeSeedTitles,
    }).catch(() => [] as BecauseRail[]),
    loadTasteGenres(userId).catch(() => [] as string[]),
  ]);

  const becauseSeen = new Set<string>();
  const becauseRails = because.slice(0, 2).map((rail) => ({
    seedTitle: rail.seedTitle,
    seedTmdbId: rail.seedTmdbId,
    items: rail.items.filter((item) => {
      const k = mediaKey(item);
      if (becauseSeen.has(k)) return false;
      becauseSeen.add(k);
      return true;
    }),
  }));

  const [genreBuckets, recBuckets] = await Promise.all([
    genreRails(tasteNames, showIds, movieIds),
    extraRecBuckets(userId, showIds, movieIds),
  ]);

  const mixedBuckets: TmdbMediaCard[][] = [
    ...becauseRails.map((r) => r.items),
    ...genreBuckets,
    ...recBuckets,
  ];
  const seen = new Set<string>();
  const forYou = interleaveBuckets(mixedBuckets, FOR_YOU_LIMIT * 2)
    .filter((item) => {
      const owned =
        item.mediaType === "tv"
          ? showIds.has(item.id)
          : movieIds.has(item.id);
      if (owned) return false;
      const k = mediaKey(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, FOR_YOU_LIMIT);

  const rawPick = pickDailyPick(forYou);
  let dailyPick: DailyPick | null = null;
  if (rawPick) {
    const item = await enrichPick(rawPick);
    dailyPick = {
      item,
      reason: dailyPickReason({
        seedTitle: becauseRails[0]?.seedTitle ?? null,
        genre: tasteNames[0] ?? null,
      }),
      trailerKey: await pickTrailer(item),
    };
  }

  return { day, dailyPick, forYou, because: becauseRails };
}

async function saveDigest(userId: string, day: string, digest: ExploreDigest) {
  try {
    await withDbRetry(() =>
      db
        .insert(userExploreDigest)
        .values({
          userId,
          day,
          dailyPick: digest.dailyPick,
          forYou: digest.forYou,
          because: digest.because,
          builtAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [userExploreDigest.userId, userExploreDigest.day],
          set: {
            dailyPick: digest.dailyPick,
            forYou: digest.forYou,
            because: digest.because,
            builtAt: new Date(),
          },
        })
    );
  } catch (err) {
    console.error(
      "explore digest write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function getOrBuildExploreDigest(
  userId: string
): Promise<ExploreDigest> {
  const day = appTodayYmd();
  let last: ExploreDigest | null = null;
  try {
    const rows = await withDbRetry(() =>
      db
        .select()
        .from(userExploreDigest)
        .where(eq(userExploreDigest.userId, userId))
        .orderBy(desc(userExploreDigest.day))
        .limit(1)
    );
    const row = rows[0];
    if (row) {
      last = {
        day: row.day,
        dailyPick: parseDailyPick(row.dailyPick),
        forYou: parseCards(row.forYou),
        because: parseBecause(row.because),
      };
    }
  } catch (err) {
    console.error(
      "explore digest read failed:",
      err instanceof Error ? err.message : err
    );
  }

  const excludeSeedIds = last?.because
    .map((r) => r.seedTmdbId)
    .filter((id) => id > 0);
  const excludeSeedTitles = last?.because.map((r) => r.seedTitle);
  const sameDay = last?.day === day;

  if (sameDay && last) {
    // Keep Daily Pick; refresh Because rails so the same two titles cannot stick.
    const because = await getBecauseYouWatched(userId, BECAUSE_ITEM_LIMIT, {
      excludeSeedIds,
      excludeSeedTitles,
    }).catch(() => [] as BecauseRail[]);
    const forYou =
      last.forYou.length > 0
        ? pickRotated(
            last.forYou,
            last.forYou.length,
            rotationOffset(userId + ":foryou", last.forYou.length)
          )
        : last.forYou;
    const digest: ExploreDigest = {
      day,
      dailyPick: last.dailyPick,
      forYou,
      because: because.length > 0 ? because : last.because,
    };
    await saveDigest(userId, day, digest);
    return digest;
  }

  const digest = await buildDigest(userId, day, {
    excludeSeedIds,
    excludeSeedTitles,
  });
  await saveDigest(userId, day, digest);
  return digest;
}

export async function getLibraryState(userId: string) {
  const [followedShows, followedMovies] = await Promise.all([
    withDbRetry(() =>
      db
        .select({ tmdbId: userShows.tmdbId })
        .from(userShows)
        .where(eq(userShows.userId, userId))
    ),
    withDbRetry(() =>
      db
        .select({ tmdbId: userMovies.tmdbId, status: userMovies.status })
        .from(userMovies)
        .where(eq(userMovies.userId, userId))
    ),
  ]);
  return {
    followedShowIds: new Set(followedShows.map((s) => s.tmdbId)),
    movieStatusById: new Map(
      followedMovies.map((m) => [m.tmdbId, m.status] as const)
    ),
    ownedMovieIds: new Set(followedMovies.map((m) => m.tmdbId)),
  };
}

/**
 * Titles the user has completely watched — powers the "N / M Seen" card on a
 * person's page. No extra API round-trip: it's one grouped read of
 * `watchedEpisodes` (joined against `shows` for the episode total) plus the
 * usual `userMovies` read, both of which this module already queries.
 *
 * A show only counts once every episode TMDB reports has been logged; a movie
 * counts once its status is `watched`.
 */
export async function getPersonSeenIds(userId: string) {
  const [showRows, movieRows] = await Promise.all([
    withDbRetry(() =>
      db
        .select({
          showTmdbId: watchedEpisodes.showTmdbId,
          watched: sql<number>`count(*)::int`,
          total: shows.numberOfEpisodes,
        })
        .from(watchedEpisodes)
        .innerJoin(shows, eq(shows.tmdbId, watchedEpisodes.showTmdbId))
        .where(eq(watchedEpisodes.userId, userId))
        .groupBy(watchedEpisodes.showTmdbId, shows.numberOfEpisodes)
    ),
    withDbRetry(() =>
      db
        .select({ tmdbId: userMovies.tmdbId })
        .from(userMovies)
        .where(
          and(eq(userMovies.userId, userId), eq(userMovies.status, "watched"))
        )
    ),
  ]);

  const watchedShowIds = new Set<number>();
  for (const row of showRows) {
    if (row.total != null && row.total > 0 && row.watched >= row.total) {
      watchedShowIds.add(row.showTmdbId);
    }
  }

  return {
    watchedShowIds,
    watchedMovieIds: new Set(movieRows.map((r) => r.tmdbId)),
  };
}
