import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";

export type EpisodeWatchRecord = {
  tvShowName: string;
  tvShowId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeId: number;
  watchedAt: Date | undefined;
};

export type ShowRecord = {
  tvShowId: number;
  name: string;
  isFollowed: boolean;
  isFavorited: boolean;
  isArchived: boolean;
  status: "watching" | "for_later" | "completed" | "dropped";
  episodesWatched: number;
  lastSeason?: number;
  lastEpisode?: number;
  lastWatchedAt?: Date;
  followedAt?: Date;
};

export type MovieRecord = {
  uuid: string;
  name: string;
  releaseDate?: string;
  runtime?: number;
  status: "watched" | "want_to_watch" | "for_later";
  watchedAt?: Date;
};

export type EpisodeReactionRecord = {
  tvShowName: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeId: number;
  reactionKey: string;
};

export type MovieReactionRecord = {
  movieName: string;
  movieUuid: string;
  reactionKey: string;
};

export type UserListRecord = {
  id: string;
  name: string;
  type: "favorite_shows" | "favorite_movies" | "custom";
  items: Array<{ tmdbId?: number; type: "tv" | "movie"; tvTimeId?: string | number; addedAt?: Date }>;
};

export type ParsedGdprData = {
  shows: Map<number, ShowRecord>;
  episodeWatches: EpisodeWatchRecord[];
  movies: MovieRecord[];
  episodeReactions: EpisodeReactionRecord[];
  movieReactions: MovieReactionRecord[];
  lists: UserListRecord[];
};

async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
}

function parseGoMap(value: string): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (!value || value === "<nil>") return result;

  // Simple parser for Go map[string]interface{} string representation
  // e.g. map[ep_id:1.044577e+07 ep_no:8 s_no:5 uuid:... watch_date:1.727543325447894e+15]
  const inner = value.replace(/^map\[/, "").replace(/\]$/, "");
  if (!inner) return result;

  // Split by space, but be careful with values containing spaces
  // We'll use a regex to match key:value pairs
  const regex = /(\w+):([^\s]+(?:\s+[^\s:]+(?=\s+\w+:|$))?)/g;
  let match;
  while ((match = regex.exec(inner)) !== null) {
    const key = match[1];
    let val: string | number | boolean = match[2];

    // Try parse number
    if (/^-?\d+\.?\d*e[+-]?\d+$/.test(val as string) || /^-?\d+\.?\d*$/.test(val as string)) {
      const num = Number(val);
      if (!isNaN(num)) val = num;
    } else if (val === "true") {
      val = true;
    } else if (val === "false") {
      val = false;
    }

    result[key] = val;
  }

  return result;
}

function parseTvTimeDate(value: number | string | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  // TV Time uses microseconds since epoch in some fields
  const num = typeof value === "string" ? Number(value) : value;
  if (isNaN(num)) return undefined;
  // If larger than 1e12, it's likely microseconds
  const ms = num > 1e12 ? num / 1000 : num;
  return new Date(ms);
}

export async function parseGdprExport(exportDir: string): Promise<ParsedGdprData> {
  const shows = new Map<number, ShowRecord>();
  const episodeWatches: EpisodeWatchRecord[] = [];
  const movies: MovieRecord[] = [];
  const episodeReactions: EpisodeReactionRecord[] = [];
  const movieReactions: MovieReactionRecord[] = [];
  const lists: UserListRecord[] = [];

  // 1. Canonical show data
  const userShowData = await readCsv(path.join(exportDir, "user_tv_show_data.csv"));
  for (const row of userShowData) {
    const tvShowId = Number(row.tv_show_id);
    const record: ShowRecord = {
      tvShowId,
      name: row.tv_show_name,
      isFollowed: row.is_followed === "1" || row.is_followed === "true",
      isFavorited: row.is_favorited === "1" || row.is_favorited === "true",
      isArchived: false,
      status: row.is_followed === "1" ? "watching" : "for_later",
      episodesWatched: Number(row.nb_episodes_seen || 0),
    };
    shows.set(tvShowId, record);
  }

  // 2. Follow data with dates
  const followedShows = await readCsv(path.join(exportDir, "followed_tv_show.csv"));
  for (const row of followedShows) {
    const tvShowId = Number(row.tv_show_id);
    const existing = shows.get(tvShowId);
    if (existing) {
      existing.followedAt = parseDate(row.created_at) || existing.followedAt;
      if (row.active === "0") {
        existing.isArchived = true;
      }
    } else {
      shows.set(tvShowId, {
        tvShowId,
        name: row.tv_show_name,
        isFollowed: row.active === "1",
        isFavorited: false,
        isArchived: row.active === "0",
        status: row.active === "1" ? "watching" : "for_later",
        episodesWatched: 0,
        followedAt: parseDate(row.created_at),
      });
    }
  }

  // 3. Special status (for_later)
  const specialStatus = await readCsv(path.join(exportDir, "user_show_special_status.csv"));
  for (const row of specialStatus) {
    const tvShowId = Number(row.tv_show_id);
    const existing = shows.get(tvShowId);
    if (existing && row.status === "for_later") {
      existing.status = "for_later";
    }
  }

  // 4. Tracking records v2 - show follows, latest episodes, and individual watches
  const trackingV2 = await readCsv(path.join(exportDir, "tracking-prod-records-v2.csv"));
  for (const row of trackingV2) {
    const key = row.key || "";

    if (key.startsWith("user-series-")) {
      const tvShowId = Number(row.s_id);
      const existing = shows.get(tvShowId);
      if (existing) {
        existing.isArchived = row.is_archived === "true" || row.is_archived === "1" || existing.isArchived;
        existing.followedAt = parseDate(row.followed_at) || existing.followedAt;

        const recent = parseGoMap(row.most_recent_ep_watched);
        if (recent.s_no && recent.ep_no) {
          existing.lastSeason = Number(recent.s_no);
          existing.lastEpisode = Number(recent.ep_no);
          existing.lastWatchedAt = parseTvTimeDate(recent.watch_date as number) || existing.lastWatchedAt;
        }
      } else if (row.series_name && row.s_id) {
        shows.set(tvShowId, {
          tvShowId,
          name: row.series_name,
          isFollowed: row.is_followed === "true" || row.is_followed === "1",
          isFavorited: false,
          isArchived: row.is_archived === "true" || row.is_archived === "1",
          status: row.is_followed === "true" || row.is_followed === "1" ? "watching" : "for_later",
          episodesWatched: Number(row.ep_watch_count || 0),
          followedAt: parseDate(row.followed_at),
        });
      }
    } else if (key.startsWith("watch-episode-")) {
      const tvShowId = Number(row.s_id);
      const seasonNumber = Number(row.season_number);
      const episodeNumber = Number(row.episode_number);
      const episodeId = Number(row.episode_id);

      if (tvShowId && seasonNumber && episodeNumber && row.series_name) {
        episodeWatches.push({
          tvShowName: row.series_name,
          tvShowId,
          seasonNumber,
          episodeNumber,
          episodeId,
          watchedAt: parseDate(row.created_at),
        });

        const existing = shows.get(tvShowId);
        if (existing) {
          existing.lastWatchedAt = parseDate(row.created_at) || existing.lastWatchedAt;
        }
      }
    }
  }

  // 5. Latest seen episode fallback
  const seenLatest = await readCsv(path.join(exportDir, "seen_episode_latest.csv"));
  for (const row of seenLatest) {
    const existing = Array.from(shows.values()).find((s) => s.name === row.tv_show_name);
    if (existing) {
      existing.lastSeason = Number(row.episode_season_number);
      existing.lastEpisode = Number(row.episode_number);
      existing.lastWatchedAt = parseDate(row.updated_at) || existing.lastWatchedAt;
    }
  }

  // 6. Movies from tracking-prod-records.csv
  const trackingV1 = await readCsv(path.join(exportDir, "tracking-prod-records.csv"));
  const movieMap = new Map<string, MovieRecord>();
  for (const row of trackingV1) {
    const entityType = row.entity_type;
    const type = row.type;
    const uuid = row.uuid;

    if (entityType === "movie" && uuid) {
      const existing = movieMap.get(uuid);
      const record: MovieRecord = {
        uuid,
        name: row.movie_name,
        releaseDate: row.release_date,
        runtime: row.runtime ? Number(row.runtime) : undefined,
        status: type === "watch" ? "watched" : existing?.status || "want_to_watch",
        watchedAt: type === "watch" ? parseDate(row.created_at) : existing?.watchedAt,
      };
      movieMap.set(uuid, record);
    }
  }
  movies.push(...Array.from(movieMap.values()).filter((m) => m.name));

  // 7. Episode reactions (both ratings and emotions files use reaction IDs)
  const episodeReactionFiles = ["ratings-3-prod-episode_votes.csv", "emotions-3-prod-episode_votes.csv"];
  for (const file of episodeReactionFiles) {
    const rows = await readCsv(path.join(exportDir, file));
    for (const row of rows) {
      const voteKey = row.vote_key || "";
      const parts = voteKey.split("-");
      const reactionKey = parts.length >= 3 ? parts[parts.length - 1] : "";
      if (reactionKey) {
        episodeReactions.push({
          tvShowName: row.series_name,
          seasonNumber: Number(row.season_number),
          episodeNumber: Number(row.episode_number),
          episodeId: Number(row.episode_id),
          reactionKey,
        });
      }
    }
  }

  // 8. Movie reactions
  const movieReactionFiles = ["ratings-live-votes.csv", "emotions-live-votes.csv"];
  for (const file of movieReactionFiles) {
    const rows = await readCsv(path.join(exportDir, file));
    for (const row of rows) {
      const voteKey = row.vote_key || "";
      const parts = voteKey.split("-");
      const reactionKey = parts.length >= 3 ? parts[parts.length - 1] : "";
      if (reactionKey && row.uuid) {
        movieReactions.push({
          movieName: row.movie_name,
          movieUuid: row.uuid,
          reactionKey,
        });
      }
    }
  }

  // 9. Lists
  const listRows = await readCsv(path.join(exportDir, "lists-prod-lists.csv"));
  for (const row of listRows) {
    if (row.s_key === "favorite-movies" || row.s_key === "favorite-series") {
      const type = row.s_key === "favorite-movies" ? "favorite_movies" : "favorite_shows";
      const name = type === "favorite_movies" ? "Favorite Movies" : "Favorite Shows";
      const items: UserListRecord["items"] = [];

      // Parse the objects column which contains Go slice of maps
      if (row.objects) {
        // Extract IDs using regex
        const regex = /(?:id|uuid):(\d+|[a-f0-9-]+)/g;
        let match;
        while ((match = regex.exec(row.objects)) !== null) {
          const id = match[1];
          if (type === "favorite_movies") {
            items.push({ type: "movie", tvTimeId: id.includes("-") ? id : Number(id) });
          } else {
            items.push({ type: "tv", tvTimeId: Number(id) });
          }
        }
      }

      lists.push({
        id: row.s_key,
        name,
        type,
        items,
      });
    }
  }

  // Mark completed shows: left as-is until TMDB episode counts land.

  return {
    shows,
    episodeWatches,
    movies,
    episodeReactions,
    movieReactions,
    lists,
  };
}
