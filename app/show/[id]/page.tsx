import { optionalAuth } from "@/lib/auth";
import { siteUrl } from "@/lib/site";
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
  getTvContentRatings,
  getTvCredits,
  getTvExternalIds,
  getTvImages,
  getTvRecommendations,
  getTvSimilar,
  getTvVideos,
  getWatchProviders,
  languageName,
  logoUrl,
  pickMovieLogo,
  pickTrailerKey,
  pickTvRating,
  posterUrl,
  backdropUrl,
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
import { getShowPlaybackPositions, type PlaybackSummary } from "@/lib/playback";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

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

/** One field off the cached TMDB payload (older rows store a subset). */
function tmdbField<T>(tmdbData: unknown, key: string): T | null {
  if (!tmdbData || typeof tmdbData !== "object") return null;
  const value = (tmdbData as Record<string, unknown>)[key];
  return (value ?? null) as T | null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tmdbId = Number(id);
  if (!Number.isFinite(tmdbId)) return {};

  const show = await ensureShow(tmdbId).catch(() => null);
  if (!show) return {};

  const title = show.title;
  const year = (show.firstAirDate ?? "").slice(0, 4);
  const description =
    show.overview?.trim() ||
    `${title}${year ? ` (${year})` : ""} — seasons, episodes and watch progress.`;
  const canonical = `${siteUrl()}/show/${tmdbId}`;
  const images = [
    show.backdropPath ? backdropUrl(show.backdropPath, "w1280") : null,
    show.posterPath ? posterUrl(show.posterPath, "w500") : null,
  ].filter((url): url is string => !!url);

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      type: "video.tv_show",
      title,
      description,
      url: canonical,
      images: images.map((url) => ({ url })),
    },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

export default async function ShowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tmdbId = Number(id);
  if (!Number.isFinite(tmdbId)) notFound();

  // Public render: signed-out visitors get the catalog page only — every
  // user row below is skipped, so no progress/ratings leak into the HTML.
  const userId = await optionalAuth();

  const show = await ensureShow(tmdbId);
  if (!show) notFound();

  const [
    userShow,
    allEpisodes,
    watched,
    rewatches,
    ownedShows,
    playbackPositions,
    externalIds,
  ] = await Promise.all([
      userId
        ? withDbRetry(() =>
            db.query.userShows.findFirst({
              where: and(
                eq(userShows.userId, userId),
                eq(userShows.tmdbId, tmdbId)
              ),
            })
          )
        : Promise.resolve(null),
      ensureEpisodes(tmdbId, show.numberOfSeasons),
      userId
        ? db
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
            )
        : Promise.resolve([]),
      userId
        ? db
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
            )
        : Promise.resolve([]),
      userId
        ? db
            .select({ tmdbId: userShows.tmdbId })
            .from(userShows)
            .where(eq(userShows.userId, userId))
        : Promise.resolve([]),
      userId
        ? getShowPlaybackPositions(
            userId,
            tmdbId,
            (show.episodeRuntime ?? 0) * 60
          )
        : Promise.resolve({} as Record<string, PlaybackSummary>),
      // Fanart keys off TheTVDB, so resolve that mapping alongside the rest.
      getTvExternalIds(tmdbId).catch(() => null),
    ]);

  const ownedIds = new Set(ownedShows.map((s) => s.tmdbId));

  /** TheTVDB id for Fanart; 0 → the Fanart helpers short-circuit to "no art". */
  const tvdbId = externalIds?.tvdb_id ?? 0;

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
    contentRatings,
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
    // Fanart indexes by TheTVDB id — a TMDB id silently answers `200 {}`.
    getShowLogoArt(tvdbId).catch(() => null),
    // Movie of the Night deep links; null → page uses the TMDB providers card.
    getShowWatchOptions(tmdbId).catch(() => null),
    getShowStickers(tvdbId).catch(() => []),
    getShowClearart(tvdbId).catch(() => null),
    // Region rating (US → "TV-MA") for the Information fact sheet.
    getTvContentRatings(tmdbId).catch(() => []),
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

  /** Fact sheet at the foot of the page (Information section). */
  const region = (process.env.WATCH_REGION || "NG").toUpperCase();
  const productionCountries = tmdbField<{ name: string }[]>(
    show.tmdbData,
    "production_countries"
  );
  const rated = pickTvRating(contentRatings, region);
  const regionOfOrigin =
    productionCountries && productionCountries.length > 0
      ? productionCountries
          .slice(0, 2)
          .map((c) => c.name)
          .join(", ")
      : null;
  const originalAudio = languageName(
    tmdbField<string>(show.tmdbData, "original_language")
  );
  const showType = tmdbField<string>(show.tmdbData, "type");

  /** Structured data scrapers read (name/description/rating/date/genre). */
  const voteCount = tmdbField<number>(show.tmdbData, "vote_count");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    name: show.title,
    description: show.overview || undefined,
    url: `${siteUrl()}/show/${tmdbId}`,
    datePublished: show.firstAirDate || undefined,
    image: show.posterPath ? posterUrl(show.posterPath, "w500") : undefined,
    genre: genresFromTmdbData(show.tmdbData),
    ...(show.voteAverage != null && show.voteAverage > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: show.voteAverage,
            bestRating: 10,
            worstRating: 0,
            ...(voteCount != null && voteCount > 0
              ? { ratingCount: voteCount }
              : {}),
          },
        }
      : {}),
  };

  return (
    <>
      <script
        type="application/ld+json"
        // `\u003c` keeps a literal "<" out of the JSON so "</script>" can't
        // break out of this element.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
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
        rated,
        regionOfOrigin,
        originalAudio,
        showType,
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
    </>
  );
}
