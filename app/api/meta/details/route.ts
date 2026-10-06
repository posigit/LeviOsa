import { auth } from "@/lib/auth";
import { getMovieDetails, getTvDetails, getTvSeason } from "@/lib/tmdb";
import { NextResponse } from "next/server";

/** Year out of a TMDB date string, null when absent/garbage. */
function yearOf(date?: string): number | null {
  const year = Number(date?.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

/**
 * Catalogue facts for the pause card on hosts that don't ship them (home
 * continue-watching, watch history, offline resume): year, runtime, rating,
 * genres, tagline and the one-line description. The player asks once per
 * mount and only when the host passed no description.
 *
 * For a TV title with ?season=&episode= the episode's own overview/runtime
 * wins (a series blurb playing under a specific episode would be wrong);
 * failing that — or failing the second lookup entirely — it falls back to
 * the series-level facts. Every failure degrades to nulls so the card keeps
 * the title-only layout rather than putting an error over the video.
 *
 * `&scope=episode` turns the fallback off: the Library caches a description
 * per downloaded row and must never store the same series blurb under every
 * episode — no episode overview simply means no description line.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const id = Number(searchParams.get("tmdbId"));
  if ((type !== "movie" && type !== "tv") || !Number.isFinite(id) || id <= 0) {
    return NextResponse.json(null);
  }

  try {
    if (type === "movie") {
      const movie = await getMovieDetails(id);
      return NextResponse.json({
        overview: movie.overview ?? null,
        tagline: movie.tagline ?? null,
        year: yearOf(movie.release_date),
        runtime: movie.runtime ?? null,
        rating: movie.vote_average ?? null,
        genres: (movie.genres ?? [])
          .map((genre) => genre.name)
          .filter(Boolean)
          .slice(0, 5),
      });
    }

    const show = await getTvDetails(id);
    const payload = {
      overview: show.overview ?? null,
      tagline: show.tagline ?? null,
      year: yearOf(show.first_air_date),
      runtime: show.episode_run_time?.[0] ?? null,
      rating: show.vote_average ?? null,
      genres: (show.genres ?? [])
        .map((genre) => genre.name)
        .filter(Boolean)
        .slice(0, 5),
    };

    const season = Number(searchParams.get("season"));
    const episode = Number(searchParams.get("episode"));
    const episodeOnly = searchParams.get("scope") === "episode";
    if (!Number.isFinite(season) || !Number.isFinite(episode)) {
      return NextResponse.json(
        episodeOnly ? { ...payload, overview: null } : payload
      );
    }
    try {
      const seasonData = await getTvSeason(id, season);
      const match = seasonData?.episodes?.find(
        (entry) => entry.episode_number === episode
      );
      if (episodeOnly) {
        return NextResponse.json({
          ...payload,
          overview: match?.overview || null,
          runtime: match?.runtime ?? payload.runtime,
        });
      }
      if (match?.overview || match?.runtime) {
        return NextResponse.json({
          ...payload,
          overview: match.overview || payload.overview,
          runtime: match.runtime ?? payload.runtime,
        });
      }
    } catch {
      // Season lookup failed — series-level facts are still worth returning.
      if (episodeOnly) return NextResponse.json({ ...payload, overview: null });
    }
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json(null);
  }
}
