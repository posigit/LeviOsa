import { db } from "@/lib/db";
import {
  episodes,
  movies,
  playbackPositions,
  shows,
  userMovies,
  watchedEpisodes,
  watchHistory,
} from "@/lib/schema";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  or,
} from "drizzle-orm";

export type PlaybackSummary = {
  positionSeconds: number;
  durationSeconds: number;
  timeLeftSeconds: number | null;
  progressPercent: number | null;
  updatedAt: string;
};

export type ContinueWatchingItem = PlaybackSummary & {
  key: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  posterPath: string | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  stillPath: string | null;
};

export type WatchHistoryItem = {
  id: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  posterPath: string | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  watchedAt: string;
  source: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
  timeLeftSeconds: number | null;
  progressPercent: number | null;
};

function summary(
  positionSeconds: number,
  durationSeconds: number,
  updatedAt: Date
): PlaybackSummary {
  const position = Math.max(0, Number(positionSeconds) || 0);
  const duration = Math.max(0, Number(durationSeconds) || 0);
  return {
    positionSeconds: position,
    durationSeconds: duration,
    timeLeftSeconds:
      duration > position ? Math.max(0, duration - position) : null,
    progressPercent:
      duration > 0 ? Math.min(100, (position / duration) * 100) : null,
    updatedAt: updatedAt.toISOString(),
  };
}

function playbackKey(
  mediaType: "movie" | "tv",
  tmdbId: number,
  seasonNumber: number,
  episodeNumber: number
) {
  return `${mediaType}:${tmdbId}:${seasonNumber}:${episodeNumber}`;
}

function isResumable(position: number, duration: number) {
  return position > 5 && (duration <= 0 || position < duration * 0.92);
}

export async function getPlaybackPosition(
  userId: string,
  mediaType: "movie" | "tv",
  tmdbId: number,
  seasonNumber = 0,
  episodeNumber = 0
): Promise<PlaybackSummary | null> {
  const [row] = await db
    .select({
      positionSeconds: playbackPositions.positionSeconds,
      durationSeconds: playbackPositions.durationSeconds,
      updatedAt: playbackPositions.updatedAt,
    })
    .from(playbackPositions)
    .where(
      and(
        eq(playbackPositions.userId, userId),
        eq(playbackPositions.mediaType, mediaType),
        eq(playbackPositions.tmdbId, tmdbId),
        eq(playbackPositions.seasonNumber, seasonNumber),
        eq(playbackPositions.episodeNumber, episodeNumber)
      )
    )
    .limit(1);

  if (!row || !isResumable(row.positionSeconds, row.durationSeconds)) {
    return null;
  }
  return summary(row.positionSeconds, row.durationSeconds, row.updatedAt);
}

export type PlaybackPositionRow = {
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: string;
};

/**
 * Every bookmark a user has, for GET /api/playback?all=1. Unlike
 * getPlaybackPosition this keeps finished rows (>= 92%) too: the offline
 * library merge needs them to clear a stale local Resume line.
 */
export async function getAllPlaybackPositions(
  userId: string
): Promise<PlaybackPositionRow[]> {
  const rows = await db
    .select({
      mediaType: playbackPositions.mediaType,
      tmdbId: playbackPositions.tmdbId,
      seasonNumber: playbackPositions.seasonNumber,
      episodeNumber: playbackPositions.episodeNumber,
      positionSeconds: playbackPositions.positionSeconds,
      durationSeconds: playbackPositions.durationSeconds,
      updatedAt: playbackPositions.updatedAt,
    })
    .from(playbackPositions)
    .where(eq(playbackPositions.userId, userId));

  return rows.map((r) => ({
    mediaType: r.mediaType === "movie" ? "movie" : "tv",
    tmdbId: r.tmdbId,
    seasonNumber: r.seasonNumber ?? 0,
    episodeNumber: r.episodeNumber ?? 0,
    positionSeconds: Math.max(0, Number(r.positionSeconds) || 0),
    durationSeconds: Math.max(0, Number(r.durationSeconds) || 0),
    updatedAt: (r.updatedAt ?? new Date(0)).toISOString(),
  }));
}

export async function getShowPlaybackPositions(
  userId: string,
  showTmdbId: number,
  fallbackRuntimeSeconds = 0
): Promise<Record<string, PlaybackSummary>> {
  const rows = await db
    .select({
      seasonNumber: playbackPositions.seasonNumber,
      episodeNumber: playbackPositions.episodeNumber,
      positionSeconds: playbackPositions.positionSeconds,
      durationSeconds: playbackPositions.durationSeconds,
      updatedAt: playbackPositions.updatedAt,
    })
    .from(playbackPositions)
    .where(
      and(
        eq(playbackPositions.userId, userId),
        eq(playbackPositions.mediaType, "tv"),
        eq(playbackPositions.tmdbId, showTmdbId)
      )
    )
    .orderBy(desc(playbackPositions.updatedAt));

  const result: Record<string, PlaybackSummary> = {};
  for (const row of rows) {
    const duration = row.durationSeconds > 0
      ? row.durationSeconds
      : fallbackRuntimeSeconds;
    if (!isResumable(row.positionSeconds, duration)) continue;
    result[`${row.seasonNumber}:${row.episodeNumber}`] = summary(
      row.positionSeconds,
      duration,
      row.updatedAt
    );
  }
  return result;
}

export async function getContinueWatching(
  userId: string,
  limit = 12
): Promise<ContinueWatchingItem[]> {
  const rows = await db
    .select({
      mediaType: playbackPositions.mediaType,
      tmdbId: playbackPositions.tmdbId,
      seasonNumber: playbackPositions.seasonNumber,
      episodeNumber: playbackPositions.episodeNumber,
      positionSeconds: playbackPositions.positionSeconds,
      durationSeconds: playbackPositions.durationSeconds,
      updatedAt: playbackPositions.updatedAt,
    })
    .from(playbackPositions)
    .where(
      and(
        eq(playbackPositions.userId, userId),
        gt(playbackPositions.positionSeconds, 5)
      )
    )
    .orderBy(desc(playbackPositions.updatedAt))
    .limit(Math.max(limit * 4, limit));

  const movieIds = rows
    .filter((row) => row.mediaType === "movie")
    .map((row) => row.tmdbId);
  const showIds = rows
    .filter((row) => row.mediaType === "tv")
    .map((row) => row.tmdbId);
  // Only these exact episodes are ever looked up below (result is capped at
  // `limit`) — never fetch whole-season catalogs for the tile map.
  const tvTuples = rows
    .filter((row) => row.mediaType === "tv")
    .map((row) => ({
      showTmdbId: row.tmdbId,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
    }));

  const [movieRows, showRows, episodeRows] = await Promise.all([
    movieIds.length > 0
      ? db
          .select({
            tmdbId: movies.tmdbId,
            title: movies.title,
            posterPath: movies.posterPath,
          })
          .from(movies)
          .where(inArray(movies.tmdbId, movieIds))
      : Promise.resolve([]),
    showIds.length > 0
      ? db
          .select({
            tmdbId: shows.tmdbId,
            title: shows.title,
            posterPath: shows.posterPath,
            episodeRuntime: shows.episodeRuntime,
          })
          .from(shows)
          .where(inArray(shows.tmdbId, showIds))
      : Promise.resolve([]),
    tvTuples.length > 0
      ? db
          .select({
            showTmdbId: episodes.showTmdbId,
            seasonNumber: episodes.seasonNumber,
            episodeNumber: episodes.episodeNumber,
            title: episodes.title,
            stillPath: episodes.stillPath,
            runtime: episodes.runtime,
          })
          .from(episodes)
          .where(
            or(
              ...tvTuples.map((k) =>
                and(
                  eq(episodes.showTmdbId, k.showTmdbId),
                  eq(episodes.seasonNumber, k.seasonNumber),
                  eq(episodes.episodeNumber, k.episodeNumber)
                )
              )
            )
          )
      : Promise.resolve([]),
  ]);

  const movieById = new Map(movieRows.map((row) => [row.tmdbId, row]));
  const showById = new Map(showRows.map((row) => [row.tmdbId, row]));
  const episodeByKey = new Map(
    episodeRows.map((row) => [
      `${row.showTmdbId}:${row.seasonNumber}:${row.episodeNumber}`,
      row,
    ])
  );

  const result: ContinueWatchingItem[] = [];
  for (const row of rows) {
    const position = row.positionSeconds;
    const episode = episodeByKey.get(
      `${row.tmdbId}:${row.seasonNumber}:${row.episodeNumber}`
    );
    const show = row.mediaType === "tv" ? showById.get(row.tmdbId) : null;
    const movie = row.mediaType === "movie" ? movieById.get(row.tmdbId) : null;
    if (!movie && !show) continue;

    const duration =
      row.durationSeconds > 0
        ? row.durationSeconds
        : ((episode?.runtime ?? show?.episodeRuntime ?? 0) * 60);
    if (!isResumable(position, duration)) continue;

    const mediaType = row.mediaType === "tv" ? "tv" : "movie";
    result.push({
      key: playbackKey(
        mediaType,
        row.tmdbId,
        row.seasonNumber,
        row.episodeNumber
      ),
      mediaType,
      tmdbId: row.tmdbId,
      title: movie?.title ?? show?.title ?? "",
      posterPath: movie?.posterPath ?? show?.posterPath ?? null,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      episodeTitle: episode?.title ?? null,
      stillPath: episode?.stillPath ?? null,
      ...summary(position, duration, row.updatedAt),
    });
    if (result.length >= limit) break;
  }
  return result;
}

export async function getWatchHistory(
  userId: string,
  limit = 50
): Promise<WatchHistoryItem[]> {
  const [historyRows, legacyEpisodes, legacyMovies, playbackRows] = await Promise.all([
    db
      .select({
        id: watchHistory.id,
        mediaType: watchHistory.mediaType,
        tmdbId: watchHistory.tmdbId,
        seasonNumber: watchHistory.seasonNumber,
        episodeNumber: watchHistory.episodeNumber,
        watchedAt: watchHistory.watchedAt,
        source: watchHistory.source,
      })
      .from(watchHistory)
      .where(eq(watchHistory.userId, userId))
      .orderBy(desc(watchHistory.watchedAt))
      .limit(limit),
    db
      .select({
        tmdbId: watchedEpisodes.showTmdbId,
        seasonNumber: watchedEpisodes.seasonNumber,
        episodeNumber: watchedEpisodes.episodeNumber,
        watchedAt: watchedEpisodes.watchedAt,
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
        tmdbId: userMovies.tmdbId,
        watchedAt: userMovies.watchedAt,
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
        mediaType: playbackPositions.mediaType,
        tmdbId: playbackPositions.tmdbId,
        seasonNumber: playbackPositions.seasonNumber,
        episodeNumber: playbackPositions.episodeNumber,
        positionSeconds: playbackPositions.positionSeconds,
        durationSeconds: playbackPositions.durationSeconds,
        updatedAt: playbackPositions.updatedAt,
      })
      .from(playbackPositions)
      .where(
        and(
          eq(playbackPositions.userId, userId),
          gt(playbackPositions.positionSeconds, 5)
        )
      )
      .orderBy(desc(playbackPositions.updatedAt))
      .limit(Math.max(limit * 2, limit)),
  ]);

  type RawHistory = {
    id: string;
    mediaType: "movie" | "tv";
    tmdbId: number;
    seasonNumber: number;
    episodeNumber: number;
    watchedAt: Date;
    source: string;
    positionSeconds?: number;
    durationSeconds?: number;
  };

  const raw: RawHistory[] = historyRows
    .filter((row) => row.mediaType === "movie" || row.mediaType === "tv")
    .map((row) => ({
      id: String(row.id),
      mediaType: row.mediaType as "movie" | "tv",
      tmdbId: row.tmdbId,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      watchedAt: row.watchedAt,
      source: row.source,
    }));

  const knownKeys = new Set(
    raw.map((row) =>
      playbackKey(row.mediaType, row.tmdbId, row.seasonNumber, row.episodeNumber)
    )
  );
  for (const row of legacyEpisodes) {
    if (!row.watchedAt) continue;
    const key = playbackKey("tv", row.tmdbId, row.seasonNumber, row.episodeNumber);
    if (knownKeys.has(key)) continue;
    knownKeys.add(key);
    raw.push({
      id: `legacy-tv-${key}`,
      mediaType: "tv",
      tmdbId: row.tmdbId,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      watchedAt: row.watchedAt,
      source: "legacy",
    });
  }
  for (const row of legacyMovies) {
    if (!row.watchedAt) continue;
    const key = playbackKey("movie", row.tmdbId, 0, 0);
    if (knownKeys.has(key)) continue;
    knownKeys.add(key);
    raw.push({
      id: `legacy-movie-${row.tmdbId}`,
      mediaType: "movie",
      tmdbId: row.tmdbId,
      seasonNumber: 0,
      episodeNumber: 0,
      watchedAt: row.watchedAt,
      source: "legacy",
    });
  }

  // A playback row is the source of truth for an in-progress stream. Merge it
  // into history only when it is newer than the last completion for that same
  // item, so returning to a finished title still appears at the top.
  const latestActivityByKey = new Map<string, number>();
  for (const row of raw) {
    const key = playbackKey(
      row.mediaType,
      row.tmdbId,
      row.seasonNumber,
      row.episodeNumber
    );
    const timestamp = row.watchedAt.getTime();
    latestActivityByKey.set(
      key,
      Math.max(latestActivityByKey.get(key) ?? 0, timestamp)
    );
  }
  for (const row of playbackRows) {
    if (row.mediaType !== "movie" && row.mediaType !== "tv") continue;
    const key = playbackKey(
      row.mediaType,
      row.tmdbId,
      row.seasonNumber,
      row.episodeNumber
    );
    const timestamp = row.updatedAt.getTime();
    if ((latestActivityByKey.get(key) ?? 0) >= timestamp) continue;
    latestActivityByKey.set(key, timestamp);
    raw.push({
      id: `playback-${key}`,
      mediaType: row.mediaType,
      tmdbId: row.tmdbId,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      watchedAt: row.updatedAt,
      source: "resume",
      positionSeconds: row.positionSeconds,
      durationSeconds: row.durationSeconds,
    });
  }

  raw.sort((a, b) => b.watchedAt.getTime() - a.watchedAt.getTime());
  const selected = raw.slice(0, limit);
  const movieIds = selected.filter((row) => row.mediaType === "movie").map((row) => row.tmdbId);
  const showIds = selected.filter((row) => row.mediaType === "tv").map((row) => row.tmdbId);
  // Same scoping as getContinueWatching: only selected episodes need titles.
  const selectedTvTuples = selected
    .filter((row) => row.mediaType === "tv")
    .map((row) => ({
      showTmdbId: row.tmdbId,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
    }));
  const [movieRows, showRows, episodeRows] = await Promise.all([
    movieIds.length > 0
      ? db
          .select({ tmdbId: movies.tmdbId, title: movies.title, posterPath: movies.posterPath })
          .from(movies)
          .where(inArray(movies.tmdbId, movieIds))
      : Promise.resolve([]),
    showIds.length > 0
      ? db
          .select({ tmdbId: shows.tmdbId, title: shows.title, posterPath: shows.posterPath })
          .from(shows)
          .where(inArray(shows.tmdbId, showIds))
      : Promise.resolve([]),
    selectedTvTuples.length > 0
      ? db
          .select({
            showTmdbId: episodes.showTmdbId,
            seasonNumber: episodes.seasonNumber,
            episodeNumber: episodes.episodeNumber,
            title: episodes.title,
          })
          .from(episodes)
          .where(
            or(
              ...selectedTvTuples.map((k) =>
                and(
                  eq(episodes.showTmdbId, k.showTmdbId),
                  eq(episodes.seasonNumber, k.seasonNumber),
                  eq(episodes.episodeNumber, k.episodeNumber)
                )
              )
            )
          )
      : Promise.resolve([]),
  ]);
  const movieById = new Map(movieRows.map((row) => [row.tmdbId, row]));
  const showById = new Map(showRows.map((row) => [row.tmdbId, row]));
  const episodeByKey = new Map(
    episodeRows.map((row) => [
      `${row.showTmdbId}:${row.seasonNumber}:${row.episodeNumber}`,
      row,
    ])
  );

  return selected.flatMap((row) => {
    const movie = row.mediaType === "movie" ? movieById.get(row.tmdbId) : null;
    const show = row.mediaType === "tv" ? showById.get(row.tmdbId) : null;
    if (!movie && !show) return [];
    const episode = episodeByKey.get(
      `${row.tmdbId}:${row.seasonNumber}:${row.episodeNumber}`
    );
    const activity =
      row.positionSeconds != null
        ? summary(row.positionSeconds, row.durationSeconds ?? 0, row.watchedAt)
        : null;
    return [
      {
        id: row.id,
        mediaType: row.mediaType,
        tmdbId: row.tmdbId,
        title: movie?.title ?? show?.title ?? "",
        posterPath: movie?.posterPath ?? show?.posterPath ?? null,
        seasonNumber: row.seasonNumber,
        episodeNumber: row.episodeNumber,
        episodeTitle: episode?.title ?? null,
        watchedAt: row.watchedAt.toISOString(),
        source: row.source,
        positionSeconds: activity?.positionSeconds ?? null,
        durationSeconds: activity?.durationSeconds ?? null,
        timeLeftSeconds: activity?.timeLeftSeconds ?? null,
        progressPercent: activity?.progressPercent ?? null,
      },
    ];
  });
}
