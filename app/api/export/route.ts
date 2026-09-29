import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  movies,
  shows,
  userLists,
  userMovies,
  userShows,
  watchHistory,
} from "@/lib/schema";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Full library backup as a JSON download. One-way (restore UI is a later
 * step): shows/movies with status/rating/favorite, custom lists with
 * snapshots, and recent watch history.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const [showRows, movieRows, listRows, historyRows] = await Promise.all([
    db
      .select({
        tmdbId: shows.tmdbId,
        title: shows.title,
        status: userShows.status,
        favorite: userShows.favorite,
        archived: userShows.archived,
        episodesWatched: userShows.episodesWatched,
        lastSeason: userShows.lastSeason,
        lastEpisode: userShows.lastEpisode,
      })
      .from(userShows)
      .innerJoin(shows, eq(userShows.tmdbId, shows.tmdbId))
      .where(eq(userShows.userId, userId)),
    db
      .select({
        tmdbId: movies.tmdbId,
        title: movies.title,
        status: userMovies.status,
        favorite: userMovies.favorite,
        watchedAt: userMovies.watchedAt,
        rating: userMovies.rating,
      })
      .from(userMovies)
      .innerJoin(movies, eq(userMovies.tmdbId, movies.tmdbId))
      .where(eq(userMovies.userId, userId)),
    db
      .select({
        name: userLists.name,
        type: userLists.type,
        items: userLists.items,
      })
      .from(userLists)
      .where(eq(userLists.userId, userId)),
    db
      .select({
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
      .limit(2000),
  ]);

  const day = new Date().toISOString().slice(0, 10);
  return NextResponse.json(
    {
      app: "leviosa",
      version: 1,
      exportedAt: new Date().toISOString(),
      shows: showRows,
      movies: movieRows,
      lists: listRows,
      history: historyRows,
    },
    {
      headers: {
        "Content-Disposition": `attachment; filename="leviosa-backup-${day}.json"`,
      },
    }
  );
}
