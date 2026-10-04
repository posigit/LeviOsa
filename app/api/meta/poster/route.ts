import { auth } from "@/lib/auth";
import { getMovieDetails, getTvDetails, getTvSeason } from "@/lib/tmdb";
import { NextResponse } from "next/server";

/**
 * Poster path lookup for offline thumbnails. The browser must not call TMDB
 * with a key, and there is no poster on a download record older than this
 * feature — the Library asks here once per title while it is online, then
 * caches the tiny image next to the download's bytes.
 *
 * With ?season=&episode= on a tv title it also returns the episode's
 * still_path (null when TMDB has none) for the 16:9 Library tile.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const id = Number(searchParams.get("id"));
  if ((type !== "movie" && type !== "tv") || !Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ posterPath: null });
  }

  try {
    const details =
      type === "movie" ? await getMovieDetails(id) : await getTvDetails(id);
    const posterPath = details?.poster_path ?? null;
    if (type !== "tv") return NextResponse.json({ posterPath });
    const season = Number(searchParams.get("season"));
    const episode = Number(searchParams.get("episode"));
    if (!Number.isFinite(season) || !Number.isFinite(episode)) {
      return NextResponse.json({ posterPath });
    }
    const seasonData = await getTvSeason(id, season);
    const match = seasonData?.episodes?.find(
      (e) => e.episode_number === episode
    );
    return NextResponse.json({
      posterPath,
      stillPath: match?.still_path ?? null,
    });
  } catch {
    return NextResponse.json({ posterPath: null });
  }
}
