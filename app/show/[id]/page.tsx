import { requireAuth } from "@/lib/auth";
import { db, withDbRetry } from "@/lib/db";
import { userShows, watchedEpisodes, seasonRewatches } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { ensureShow, ensureEpisodes } from "@/lib/ensure";
import {
  ShowDetailClient,
  DetailEpisode,
  type ShowCastMember,
} from "@/components/show-detail-client";
import { filterNewMedia } from "@/lib/recommend";
import {
  getTvCredits,
  getTvImages,
  getTvRecommendations,
  getTvSimilar,
  getTvVideos,
  getWatchProviders,
  logoUrl,
  pickMovieLogo,
  pickTrailerKey,
} from "@/lib/tmdb";
import { genresFromTmdbData } from "@/lib/profile-insights";
import {
  getShowLogoArt,
  getShowStickers,
  getShowClearart,
} from "@/lib/fanart";
import { getShowWatchOptions } from "@/lib/motn";
import { getCommunityReviews } from "@/lib/reviews";
import { getMovieTheme } from "@/lib/movie-theme";
import { getShowPlaybackPositions } from "@/lib/playback";
import { notFound } from "next/navigation";

/** TMDB details keeps `created_by`; the stored row type does not declare it. */
function creatorsFromTmdbData(tmdbData: unknown): string[] {
  if (!tmdbData || typeof tmdbData !== "object") return [];
  const list = (tmdbData as { created_by?: unknown }).created_by;
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const item of list) {
    const n = String((item as { name?: unknown })?.name ?? "").trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

export default async function ShowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tmdbId = Number(id);
  if (!Number.isFinite(tmdbId)) notFound();

  const userId = await requireAuth();

  const show = await ensureShow(tmdbId);
  if (!show) notFound();

  const [userShow, allEpisodes, watched, rewatches, ownedShows, playbackPositions] =
    await Promise.all([
      withDbRetry(() =>
        db.query.userShows.findFirst({
          where: and(eq(userShows.userId, userId), eq(userShows.tmdbId, tmdbId)),
        })
      ),
      ensureEpisodes(tmdbId, show.numberOfSeasons),
      db
        .select({
          seasonNumber: watchedEpisodes.seasonNumber,
          episodeNumber: watchedEpisodes.episodeNumber,
          rating: watchedEpisodes.rating,
        })
        .from(watchedEpisodes)
        .where(
          and(
            eq(watchedEpisodes.userId, userId),
            eq(watchedEpisodes.showTmdbId, tmdbId)
          )
        ),
      db
        .select({
          seasonNumber: seasonRewatches.seasonNumber,
          count: seasonRewatches.count,
        })
        .from(seasonRewatches)
        .where(
          and(
            eq(seasonRewatches.userId, userId),
            eq(seasonRewatches.showTmdbId, tmdbId)
          )
        ),
      db
        .select({ tmdbId: userShows.tmdbId })
        .from(userShows)
        .where(eq(userShows.userId, userId)),
      getShowPlaybackPositions(userId, tmdbId, (show.episodeRuntime ?? 0) * 60),
    ]);

  const ownedIds = new Set(ownedShows.map((s) => s.tmdbId));

  const [
    similarRaw,
    recsRaw,
    providers,
    reviews,
    videos,
    theme,
    images,
    credits,
    fanartLogo,
    watch,
    stickers,
    clearartSrc,
  ] = await Promise.all([
    getTvSimilar(tmdbId).catch(() => []),
    getTvRecommendations(tmdbId).catch(() => []),
    getWatchProviders(tmdbId, "tv").catch(() => ({
      flatrate: [],
      rent: [],
      buy: [],
    })),
    getCommunityReviews({
      kind: "tv",
      tmdbId,
      title: show.title,
      year: show.firstAirDate,
      knownRtScore: show.rtScore,
      knownRtAudienceScore: show.rtAudienceScore,
      knownMcScore: show.mcScore,
    }).catch(() => ({
      reviews: [],
      rtScore:
        show.rtScore != null && show.rtScore >= 0 ? show.rtScore : null,
      rtAudienceScore:
        show.rtAudienceScore != null && show.rtAudienceScore >= 0
          ? show.rtAudienceScore
          : null,
      mcScore:
        show.mcScore != null && show.mcScore >= 0 ? show.mcScore : null,
      rtState: null,
      rtUrl: null,
      counts: { all: 0, rt: 0, tmdb: 0, reddit: 0, fresh: 0, rotten: 0 },
    })),
    getTvVideos(tmdbId).catch(() => []),
    // Per-show page theme (poster-dominant color) — same accents as movies.
    getMovieTheme(show.posterPath, show.backdropPath),
    getTvImages(tmdbId).catch(() => ({ logos: [] })),
    getTvCredits(tmdbId).catch(() => ({ cast: [], crew: [] })),
    // Fanart transparent wordmark wins over TMDB; TMDB stays the fallback.
    getShowLogoArt(tmdbId).catch(() => null),
    // Movie of the Night deep links; null → page uses the TMDB providers card.
    getShowWatchOptions(tmdbId).catch(() => null),
    getShowStickers(tmdbId).catch(() => []),
    getShowClearart(tmdbId).catch(() => null),
  ]);

  // Original-font title treatment (Fanart, then TMDB logo artwork).
  const logoSrc = fanartLogo ?? logoUrl(pickMovieLogo(images?.logos));

  const moreLikeThis = filterNewMedia(similarRaw, ownedIds, 12);
  const recommended = filterNewMedia(recsRaw, ownedIds, 12);

  const watchedSet = new Set(
    watched.map((w) => `${w.seasonNumber}:${w.episodeNumber}`)
  );

  const episodeRatings: Record<string, number> = {};
  let ratingSum = 0;
  let ratingCount = 0;
  for (const w of watched) {
    if (w.rating != null) {
      episodeRatings[`${w.seasonNumber}:${w.episodeNumber}`] = w.rating;
      ratingSum += w.rating;
      ratingCount++;
    }
  }
  const derivedScore =
    ratingCount > 0
      ? { value: Math.round(ratingSum / ratingCount), count: ratingCount }
      : null;

  const episodes: DetailEpisode[] = allEpisodes
    .slice()
    .sort((a, b) =>
      a.seasonNumber !== b.seasonNumber
        ? a.seasonNumber - b.seasonNumber
        : a.episodeNumber - b.episodeNumber
    )
    .map((ep) => ({
      episodeNumber: ep.episodeNumber,
      seasonNumber: ep.seasonNumber,
      title: ep.title,
      overview: ep.overview ?? undefined,
      airDate: ep.airDate ?? undefined,
      stillPath: ep.stillPath ?? null,
      runtime: ep.runtime ?? undefined,
      watched: watchedSet.has(`${ep.seasonNumber}:${ep.episodeNumber}`),
    }));

  const rewatchCounts: Record<number, number> = {};
  for (const r of rewatches) {
    rewatchCounts[r.seasonNumber] = r.count;
  }

  /** Billed cast, trimmed to what the Stickers rail fits on one screen. */
  const cast: ShowCastMember[] = credits.cast
    .filter((c) => c.profile_path)
    .slice(0, 12)
    .map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character ?? null,
      profilePath: c.profile_path ?? null,
    }));

  return (
    <ShowDetailClient
      show={{
        tmdbId: show.tmdbId,
        title: show.title,
        posterPath: show.posterPath,
        backdropPath: show.backdropPath,
        overview: show.overview,
        status: show.status,
        networks: show.networks,
        numberOfSeasons: show.numberOfSeasons,
        numberOfEpisodes: show.numberOfEpisodes,
        episodeRuntime: show.episodeRuntime,
        voteAverage: show.voteAverage,
        rtScore: show.rtScore ?? null,
        firstAirDate: show.firstAirDate,
        genres: genresFromTmdbData(show.tmdbData),
      }}
      creators={creatorsFromTmdbData(show.tmdbData)}
      cast={cast}
      stickers={stickers}
      clearartSrc={clearartSrc}
      watch={watch}
      episodes={episodes}
      rewatchCounts={rewatchCounts}
      initialFollowing={!!userShow}
      initialFavorite={userShow?.favorite ?? false}
      episodeRatings={episodeRatings}
      derivedScore={derivedScore}
      playbackPositions={playbackPositions}
      moreLikeThis={moreLikeThis}
      recommended={recommended}
      providers={providers}
      reviews={reviews}
      trailerKey={pickTrailerKey(videos)}
      videos={videos}
      theme={theme}
      logoSrc={logoSrc}
    />
  );
}
