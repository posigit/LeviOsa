import { optionalAuth } from "@/lib/auth";
import { siteUrl } from "@/lib/site";
import { db, withDbRetry } from "@/lib/db";
import { userMovies, watchHistory } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import {
  backdropUrl,
  posterUrl,
  logoUrl,
  getMovieCredits,
  getMovieDetails,
  getMovieImages,
  getMovieRecommendations,
  getMovieReleaseDates,
  getMovieSimilar,
  getMovieVideos,
  getWatchProviders,
  languageName,
  pickCertification,
  pickMovieLogo,
  pickTrailerKey,
} from "@/lib/tmdb";
import { getCommunityReviews } from "@/lib/reviews";
import { ensureMovie } from "@/lib/ensure";
import { getMovieTheme } from "@/lib/movie-theme";
import { filterNewMedia } from "@/lib/recommend";
import { getMovieStickers } from "@/lib/fanart";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Play,
  ShieldAlert,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { TmdbIcon } from "@/components/rt-icons";
import { MovieWatchButton } from "@/components/movie-watch-button";
import { FavoriteButton } from "@/components/favorite-button";
import { AddToListButton } from "@/components/add-to-list-button";
import { MovieRewatchButton } from "@/components/movie-rewatch-button";
// import { ReactionPicker } from "@/components/reaction-picker"; // hidden for now
import { MovieRating } from "@/components/star-rating";
import { DiscoverRail } from "@/components/discover-rail";
import { WatchProviders } from "@/components/watch-providers";
import { CommunityReviews } from "@/components/community-reviews";
import { ScoreStrip } from "@/components/score-strip";
import { InfoList, type InfoListItem } from "@/components/info-list";
import { MovieVixButton } from "@/components/movie-vix-button";
import { DownloadButton } from "@/components/download-button";
import { getPlaybackPosition } from "@/lib/playback";
import { formatPlaybackTime } from "@/lib/playback-format";
import type { Metadata } from "next";

function formatRuntime(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Genre names from the cached TMDB details JSON (tmdb_data.genres). */
function genresFromTmdbData(tmdbData: unknown): string[] {
  if (!tmdbData || typeof tmdbData !== "object") return [];
  const genres = (tmdbData as { genres?: unknown }).genres;
  if (!Array.isArray(genres)) return [];
  return genres
    .map((g) =>
      g && typeof g === "object" && "name" in g
        ? String((g as { name: unknown }).name)
        : ""
    )
    .filter((name) => name.length > 0)
    .slice(0, 5);
}

/** Safe accessor for fields on the cached tmdb_data JSON blob. */
function tmdbField<T>(tmdbData: unknown, key: string): T | null {
  if (!tmdbData || typeof tmdbData !== "object") return null;
  const value = (tmdbData as Record<string, unknown>)[key];
  return (value ?? null) as T | null;
}

function formatReleaseDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoneyShort(n: number | null | undefined): string | null {
  if (n == null || n <= 0) return null;
  if (n >= 1_000_000_000)
    return `$${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${n}`;
}

function formatMoneyFull(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tmdbId = Number(id);
  if (!Number.isFinite(tmdbId)) return {};

  const movie = await ensureMovie(tmdbId).catch(() => null);
  if (!movie) return {};

  const title = movie.title;
  const year = (movie.releaseDate ?? "").slice(0, 4);
  const description =
    movie.overview?.trim() ||
    `${title}${year ? ` (${year})` : ""} — runtime, cast, ratings and where to watch.`;
  const canonical = `${siteUrl()}/movie/${tmdbId}`;
  const images = [
    movie.backdropPath ? backdropUrl(movie.backdropPath, "w1280") : null,
    movie.posterPath ? posterUrl(movie.posterPath, "w500") : null,
  ].filter((url): url is string => !!url);

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      type: "video.movie",
      title,
      description,
      url: canonical,
      images: images.map((url) => ({ url })),
    },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

export default async function MovieDetailPage({
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

  const movie = await ensureMovie(tmdbId);
  if (!movie) notFound();

  const loadUserMovie = async () => {
    if (!userId) return null;
    try {
      return await withDbRetry(() =>
        db.query.userMovies.findFirst({
          where: and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId)),
        })
      );
    } catch {
      // Pre-migration DB without rewatch_queued — select without the column.
      const [row] = await withDbRetry(() =>
        db
          .select({
            userId: userMovies.userId,
            tmdbId: userMovies.tmdbId,
            status: userMovies.status,
            favorite: userMovies.favorite,
            watchedAt: userMovies.watchedAt,
            rating: userMovies.rating,
            updatedAt: userMovies.updatedAt,
          })
          .from(userMovies)
          .where(
            and(eq(userMovies.userId, userId), eq(userMovies.tmdbId, tmdbId))
          )
          .limit(1)
      ).catch(() => [null] as const);
      return row ?? null;
    }
  };

  const [userMovie, ownedMovies, playback, movieHistoryRows] = userId
    ? await Promise.all([
        loadUserMovie(),
        db
          .select({ tmdbId: userMovies.tmdbId })
          .from(userMovies)
          .where(eq(userMovies.userId, userId)),
        getPlaybackPosition(userId, "movie", tmdbId),
        db
          .select({ watchedAt: watchHistory.watchedAt })
          .from(watchHistory)
          .where(
            and(
              eq(watchHistory.userId, userId),
              eq(watchHistory.mediaType, "movie"),
              eq(watchHistory.tmdbId, tmdbId)
            )
          ),
      ])
    : ([null, [], null, []] as const);
  /**
   * `watchHistory` gets a row on the first mark-watched *and* on every
   * rewatch, so the row count is the total times watched. Anything that adds
   * one to it double-counts — the pill, the rewatch chip and the hero bar all
   * read this number.
   */
  const movieRewatchCount = movieHistoryRows.length;
  const userMovieRow = (userMovie ?? null) as
    | (NonNullable<typeof userMovie> & { rewatchQueued?: boolean | null })
    | null;
  const isRewatchQueued = userMovieRow?.rewatchQueued === true;

  const ownedIds = new Set(ownedMovies.map((m) => m.tmdbId));

  const [
    similarRaw,
    recsRaw,
    providers,
    credits,
    reviews,
    videos,
    details,
    images,
    releaseDates,
    theme,
    stickers,
  ] = await Promise.all([
    getMovieSimilar(tmdbId).catch(() => []),
    getMovieRecommendations(tmdbId).catch(() => []),
    getWatchProviders(tmdbId, "movie").catch(() => ({
      flatrate: [],
      rent: [],
      buy: [],
    })),
    getMovieCredits(tmdbId).catch(() => null),
    getCommunityReviews({
      kind: "movie",
      tmdbId,
      title: movie.title,
      year: movie.releaseDate,
      knownRtScore: movie.rtScore,
      knownRtAudienceScore: movie.rtAudienceScore,
      knownMcScore: movie.mcScore,
    }).catch(() => ({
      reviews: [],
      rtScore: movie.rtScore != null && movie.rtScore >= 0 ? movie.rtScore : null,
      rtAudienceScore:
        movie.rtAudienceScore != null && movie.rtAudienceScore >= 0
          ? movie.rtAudienceScore
          : null,
      mcScore: movie.mcScore != null && movie.mcScore >= 0 ? movie.mcScore : null,
      rtState: null,
      rtUrl: null,
      counts: { all: 0, rt: 0, tmdb: 0, reddit: 0, fresh: 0, rotten: 0 },
    })),
    getMovieVideos(tmdbId).catch(() => []),
    getMovieDetails(tmdbId).catch(() => null),
    getMovieImages(tmdbId).catch(() => ({ logos: [] })),
    getMovieReleaseDates(tmdbId).catch(() => []),
    getMovieTheme(movie.posterPath, movie.backdropPath),
    getMovieStickers(tmdbId).catch(() => [] as string[]),
  ]);

  const moreLikeThis = filterNewMedia(similarRaw, ownedIds, 12);
  const recommended = filterNewMedia(recsRaw, ownedIds, 12);
  const crewList = credits?.crew ?? [];
  const seenDirectors = new Set<string>();
  const directorsWithIds: { name: string; id: number | null }[] = [];
  for (const c of crewList) {
    if (c.job !== "Director" || !c.name || seenDirectors.has(c.name)) continue;
    seenDirectors.add(c.name);
    directorsWithIds.push({ name: c.name, id: c.id ?? null });
  }
  const cast = (credits?.cast ?? []).slice(0, 12);

  // Fresh details first, cached tmdb_data as fallback for older rows.
  const genres =
    details?.genres?.map((g) => g.name).filter(Boolean).slice(0, 5) ??
    genresFromTmdbData(movie.tmdbData);
  const tagline =
    details?.tagline || tmdbField<string>(movie.tmdbData, "tagline") || null;
  const budget =
    details?.budget ?? tmdbField<number>(movie.tmdbData, "budget") ?? 0;
  const revenue =
    details?.revenue ?? tmdbField<number>(movie.tmdbData, "revenue") ?? 0;
  const studios =
    details?.production_companies ??
    tmdbField<
      { id: number; name: string; logo_path?: string | null; origin_country?: string }[]
    >(movie.tmdbData, "production_companies") ??
    [];
  const status = movie.status ?? details?.status ?? null;
  const productionCountries =
    details?.production_countries ??
    tmdbField<{ iso_3166_1: string; name: string }[]>(
      movie.tmdbData,
      "production_countries"
    ) ??
    [];
  const language =
    languageName(details?.original_language) ??
    languageName(tmdbField<string>(movie.tmdbData, "original_language"));
  const isAdult =
    details?.adult ?? tmdbField<boolean>(movie.tmdbData, "adult") ?? false;

  // Original-font title treatment (TMDB logo artwork), like the reference app.
  const logoPath = pickMovieLogo(images?.logos);
  const logoSrc = logoUrl(logoPath);

  // Parental guide: theatrical certification, US first then app region.
  const region = (process.env.WATCH_REGION || "NG").toUpperCase();
  const certification = pickCertification(releaseDates, region);

  const trailerKey = pickTrailerKey(videos);
  const trailerName =
    videos.find((v) => v.key === trailerKey)?.name ?? "Official Trailer";
  const trailerThumb = trailerKey
    ? `https://i.ytimg.com/vi/${trailerKey}/hqdefault.jpg`
    : null;
  const trailerPoster = trailerThumb ?? backdropUrl(movie.backdropPath, "w1280");
  const extraTrailers = videos
    .filter((v) => v.site === "YouTube" && v.key && v.key !== trailerKey)
    .slice(0, 5);

  const releaseLabel = formatReleaseDate(movie.releaseDate);
  const runtimeLabel = movie.runtime ? formatRuntime(movie.runtime) : null;
  /** Hero meta line: genres first, then the runtime (wraps like the show page). */
  const heroMeta = [
    ...genres.slice(0, 3),
    ...(runtimeLabel ? [runtimeLabel] : []),
  ];
  const releaseYear =
    movie.releaseDate && movie.releaseDate.length >= 4
      ? movie.releaseDate.slice(0, 4)
      : null;
  const yearNum =
    releaseYear && /^\d{4}$/.test(releaseYear) ? releaseYear : null;

  /** Full-bleed key art: the poster crops best in a portrait frame; the
      backdrop (or nothing) is the fallback. */
  const heroSrc = movie.posterPath
    ? posterUrl(movie.posterPath, "original")
    : movie.backdropPath
      ? backdropUrl(movie.backdropPath, "original")
      : null;

  // Title-meta rating: Tomatometer first, TMDB star only when no RT score.
  const heroRt =
    reviews.rtScore != null && reviews.rtScore >= 0
      ? reviews.rtScore
      : movie.rtScore != null && movie.rtScore >= 0
        ? movie.rtScore
        : null;

  const isWatched = userMovie?.status === "watched";

  /** Hero score: Tomatometer wins, the TMDB star only when there is no RT score. */
  const ratingText =
    heroRt != null
      ? `${heroRt}%`
      : movie.voteAverage
        ? `${movie.voteAverage.toFixed(1)}/10`
        : null;

  /**
   * Hero bar tracks where you actually are: "Resume / 1h 40m left" with the
   * fill at the current position while a bookmark exists, "Watched / 1x"
   * (full) once it's finished. Hidden until the movie has been started.
   */
  const timeLeftText = formatPlaybackTime(playback?.timeLeftSeconds ?? null);
  const inProgress = playback != null;
  const positionPct = Math.max(
    0,
    Math.min(100, playback?.progressPercent ?? 0)
  );
  const progressStarted = inProgress || isWatched;

  /** Structured data scrapers read (name/description/rating/date/genre). */
  const voteCount = tmdbField<number>(movie.tmdbData, "vote_count");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: movie.title,
    description: movie.overview || undefined,
    url: `${siteUrl()}/movie/${tmdbId}`,
    datePublished: movie.releaseDate || undefined,
    image: movie.posterPath ? posterUrl(movie.posterPath, "w500") : undefined,
    genre: genresFromTmdbData(movie.tmdbData),
    ...(movie.voteAverage != null && movie.voteAverage > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: movie.voteAverage,
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
    <div
      className="min-h-dvh bg-black pb-safe-page"
      style={
        {
          "--theme": theme.v,
          "--theme-deep": theme.deep,
        } as CSSProperties
      }
    >
      {/* ---------- Floating controls: stick over the scroll, like the app ---------- */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-40 px-4 top-safe-float">
        <div className="pointer-events-auto flex items-center justify-between">
          <Link
            href="/movies"
            aria-label="Back to movies"
            className="glass-control grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <AddToListButton
            mediaType="movie"
            tmdbId={tmdbId}
            title={movie.title}
            posterPath={movie.posterPath}
          />
        </div>
      </div>

      {/* ---------- Full-bleed hero ---------- */}
      <div className="relative isolate h-[72dvh] max-h-[720px] min-h-[460px] overflow-hidden">
        {heroSrc ? (
          <Image
            src={heroSrc}
            alt={`${movie.title} key art`}
            fill
            sizes="100vw"
            className="object-cover object-top"
            priority
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, rgb(var(--theme) / 0.55), #000)",
            }}
          />
        )}

        {/* Theme seam: tints the art and sits UNDER both scrims so the page
            edge below the hero crushes to true black instead of leaving a
            theme-coloured band across the CTA row. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 60% at 50% 100%, rgb(var(--theme) / 0.32), transparent 70%)",
          }}
        />

        {/* Legibility scrims: controls readable up top, title readable below. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/75 via-black/35 to-transparent"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[58%]"
          style={{
            background:
              "linear-gradient(to top, #000 14%, rgb(0 0 0 / 0.82) 34%, rgb(0 0 0 / 0.45) 62%, transparent)",
          }}
        />

        {/* Hero footer: certificate -> title -> tagline -> meta -> rating.
            Bottom padding only matches the bar's footprint when the bar is
            there — an unstarted movie shouldn't carry an empty gap. */}
        <div
          className={`absolute inset-x-0 bottom-0 px-5 text-center ${
            progressStarted ? "pb-6" : "pb-2"
          }`}
        >
          {(certification || releaseYear) && (
            <span className="glass-control inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/90">
              {yearNum ? (
                <Link
                  href={`/movie/year/${yearNum}`}
                  className="transition hover:text-primary"
                >
                  {releaseYear}
                </Link>
              ) : (
                releaseYear
              )}
              {certification && releaseYear && (
                <span aria-hidden className="text-white/40">
                  {"·"}
                </span>
              )}
              {certification?.code}
            </span>
          )}

          <h1 className="mt-3 flex justify-center px-4">
            {logoSrc ? (
              <Image
                src={logoSrc}
                alt={movie.title}
                width={512}
                height={288}
                sizes="(max-width: 480px) 88vw, 460px"
                className="h-16 w-auto max-w-full object-contain drop-shadow-[0_6px_22px_rgba(0,0,0,0.95)] sm:h-20"
                unoptimized
              />
            ) : (
              <span className="text-4xl font-black tracking-tight text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.9)]">
                {movie.title}
              </span>
            )}
          </h1>

          {tagline ? (
            <p className="mx-auto mt-1.5 max-w-md text-[13px] italic leading-snug text-white/55">
              {tagline}
            </p>
          ) : null}

          {heroMeta.length > 0 && (
            <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-[15px] text-white/75">
              {heroMeta.map((item, i) => (
                <span key={item} className="inline-flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden className="text-white/35">
                      {"\u00b7"}
                    </span>
                  )}
                  {item}
                </span>
              ))}
            </p>
          )}

          {ratingText && (
            <div className="mt-2.5 flex items-center justify-center gap-1.5">
              {heroRt != null ? (
                <span className="text-lg leading-none" title="Rotten Tomatoes">
                  🍅
                </span>
              ) : (
                <TmdbIcon className="h-4 w-4" />
              )}
              <span className="text-sm font-bold text-white/85">{ratingText}</span>
            </div>
          )}

          {progressStarted && (
            <div className="mt-5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-white/85">
                  {inProgress ? "Resume" : "Watched"}
                </span>
                <span className="font-semibold text-white">
                  {inProgress
                    ? timeLeftText
                      ? `${timeLeftText} left`
                      : `${positionPct.toFixed(0)}%`
                    : `${Math.max(movieRewatchCount, isWatched ? 1 : 0)}x`}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/25">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-500"
                  style={{ width: `${inProgress ? positionPct : 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------- Primary CTA: liquid-glass pill + favorite ---------- */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <MovieVixButton
          tmdbId={tmdbId}
          title={movie.title}
          isWatched={isWatched}
          isRewatchQueued={isRewatchQueued}
          playback={playback}
          pausedDetails={{
            overview: movie.overview ?? null,
            year: yearNum ? Number(yearNum) : null,
            runtime: movie.runtime ?? null,
            rating: movie.voteAverage ?? null,
            genres,
          }}
          className="h-12 flex-1 rounded-full px-4"
        />
        <FavoriteButton
          mediaType="movie"
          tmdbId={tmdbId}
          initialFavorite={userMovie?.favorite ?? false}
          className="h-12 w-12"
        />
      </div>

      {/* ---------- Body ---------- */}
      <div className="relative px-4 pt-3">
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1">
            <MovieWatchButton
              tmdbId={tmdbId}
              initialStatus={userMovie?.status || null}
            />
          </div>
          {isWatched && (
            <MovieRewatchButton
              tmdbId={tmdbId}
              initialCount={movieRewatchCount}
              initialQueued={isRewatchQueued}
            />
          )}
          {/* Offline download icon — null (zero space) while mode is off. */}
          <DownloadButton
            variant="icon"
            className="h-11 w-11"
            item={{ type: "movie", tmdbId, title: movie.title, poster: movie.posterPath }}
          />
        </div>

        {/* Reactions hidden for now — emoji row felt noisy next to scores.
        <div className="mt-3">
          <ReactionPicker
            size="md"
            item={{ type: "movie", tmdbId }}
            initialKeys={movieReactionKeys}
          />
        </div>
        */}

        {/* Critic + audience scores in frosted glass */}
        <div className="glass-panel mt-4 overflow-hidden rounded-3xl">
          <ScoreStrip
            className="mt-0 border-y-0"
            rtScore={reviews.rtScore}
            rtAudienceScore={reviews.rtAudienceScore}
            voteAverage={movie.voteAverage}
          />
        </div>

        {/* Your stars only after Mark Watched — not for unwatched titles */}
        {isWatched && (
          <div className="glass-panel mt-3 rounded-3xl p-4">
            <MovieRating
              tmdbId={tmdbId}
              initialRating={userMovie?.rating ?? null}
            />
          </div>
        )}

        {movie.overview && (
          <section className="mt-5">
            <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
              Storyline
            </h2>
            <p className="text-sm leading-relaxed text-white/85">
              {movie.overview}
            </p>
          </section>
        )}

        {/* ---------- Trailers (reference placement) ---------- */}
        {trailerPoster && (
          <section className="mt-6">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-[22px] font-extrabold tracking-tight text-white">
                Trailers
              </h2>
              {videos.length > 1 && (
                <span className="text-xs font-semibold text-white/40">
                  {videos.length} videos
                </span>
              )}
            </div>
            <a
              href={`https://www.youtube.com/watch?v=${trailerKey}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Watch ${movie.title} trailer on YouTube`}
              className="group relative block overflow-hidden rounded-[1.75rem] shadow-[0_20px_60px_-16px_rgb(var(--theme)/0.55)] ring-1 ring-white/15 transition active:scale-[0.99]"
            >
              <div className="relative aspect-video bg-secondary">
                <Image
                  src={trailerPoster}
                  alt={`${movie.title} trailer thumbnail`}
                  fill
                  sizes="(max-width: 480px) 100vw, 480px"
                  className="object-cover transition duration-300 group-hover:scale-[1.03]"
                  unoptimized
                />
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(to top, rgb(var(--theme-deep) / 0.7), transparent 55%, rgb(var(--theme-deep) / 0.25))",
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.18] shadow-[0_12px_32px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.45),0_0_44px_rgb(var(--theme)/0.5)] ring-1 ring-white/50 backdrop-blur-2xl transition group-hover:scale-105">
                    <span
                      aria-hidden
                      className="absolute left-3 top-2 h-4 w-8 rounded-full bg-white/40 blur-[6px]"
                    />
                    <Play className="ml-1 h-6 w-6 fill-white text-white" />
                  </span>
                </div>
              </div>
            </a>
            <p className="mt-2 text-sm text-white/80">{trailerName}</p>

            {extraTrailers.length > 0 && (
              <div className="-mx-4 mt-3 flex gap-2.5 overflow-x-auto px-4 pb-1 scrollbar-none">
                {extraTrailers.map((v) => (
                  <a
                    key={v.id}
                    href={`https://www.youtube.com/watch?v=${v.key}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group w-40 flex-shrink-0"
                  >
                    <div className="relative aspect-video overflow-hidden rounded-xl ring-1 ring-white/10">
                      <Image
                        src={`https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`}
                        alt={v.name ?? "Trailer"}
                        fill
                        sizes="160px"
                        className="object-cover transition duration-300 group-hover:scale-[1.04]"
                        unoptimized
                      />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.18] ring-1 ring-white/40 backdrop-blur-xl">
                          <Play className="ml-0.5 h-3.5 w-3.5 fill-white text-white" />
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 truncate text-[11px] font-medium text-white/60">
                      {v.name ?? "Trailer"}
                    </p>
                  </a>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ---------- Details: budget, revenue, parental guide, studios ---------- */}
        <section className="mt-6">
          <h2 className="mb-2.5 text-[22px] font-extrabold tracking-tight text-white">
            Details
          </h2>
          <div className="glass-panel rounded-3xl px-4 py-1.5">
            {directorsWithIds.length > 0 && (
              <div className="flex justify-between gap-3 border-b border-white/[0.06] py-2.5 text-sm last:border-0">
                <span className="shrink-0 text-white/45">
                  {directorsWithIds.length > 1 ? "Directors" : "Director"}
                </span>
                <span className="text-right font-medium text-white">
                  {directorsWithIds.map((d, i) => (
                    <span key={d.name}>
                      {i > 0 ? ", " : ""}
                      {d.id != null ? (
                        <Link
                          href={`/person/${d.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {d.name}
                        </Link>
                      ) : (
                        d.name
                      )}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {releaseLabel && (
              <div className="flex justify-between gap-3 border-b border-white/[0.06] py-2.5 text-sm last:border-0">
                <span className="shrink-0 text-white/45">Released</span>
                <span className="text-right font-medium text-white">
                  {yearNum ? (
                    <Link
                      href={`/movie/year/${yearNum}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {releaseLabel}
                    </Link>
                  ) : (
                    releaseLabel
                  )}
                </span>
              </div>
            )}
            {status && (
              <div className="flex justify-between gap-3 border-b border-white/[0.06] py-2.5 text-sm last:border-0">
                <span className="shrink-0 text-white/45">Status</span>
                <span className="text-right font-medium text-white">
                  {status}
                </span>
              </div>
            )}
            {language && (
              <div className="flex justify-between gap-3 border-b border-white/[0.06] py-2.5 text-sm last:border-0">
                <span className="shrink-0 text-white/45">
                  Original language
                </span>
                <span className="text-right font-medium text-white">
                  {language}
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2.5 py-3">
              <div className="rounded-2xl bg-white/[0.05] px-3 py-2.5 ring-1 ring-white/[0.08]">
                <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/40">
                  <Wallet className="h-3 w-3" /> Budget
                </p>
                <p
                  title={budget > 0 ? formatMoneyFull(budget) : undefined}
                  className="mt-1 text-base font-black text-white"
                >
                  {formatMoneyShort(budget) ?? (
                    <span className="text-sm font-semibold text-white/35">
                      Not disclosed
                    </span>
                  )}
                </p>
              </div>
              <div className="rounded-2xl bg-white/[0.05] px-3 py-2.5 ring-1 ring-white/[0.08]">
                <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/40">
                  <TrendingUp className="h-3 w-3" /> Revenue
                </p>
                <p
                  title={revenue > 0 ? formatMoneyFull(revenue) : undefined}
                  className="mt-1 text-base font-black text-white"
                >
                  {formatMoneyShort(revenue) ?? (
                    <span className="text-sm font-semibold text-white/35">
                      Not disclosed
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] py-2.5 text-sm">
              <span className="flex shrink-0 items-center gap-1.5 text-white/45">
                <ShieldAlert className="h-3.5 w-3.5" /> Parental guide
              </span>
              {certification ? (
                <span className="flex items-center gap-1.5">
                  <span className="rounded-md bg-white/[0.12] px-2 py-0.5 text-xs font-black text-white ring-1 ring-white/30">
                    {certification.code}
                  </span>
                  <span className="text-xs text-white/40">
                    {certification.country}
                    {isAdult ? " · 18+" : ""}
                  </span>
                </span>
              ) : (
                <span className="text-sm font-medium text-white/35">
                  {isAdult ? "Adult · 18+" : "Not rated"}
                </span>
              )}
            </div>
            {studios.length > 0 && (
              <div className="border-t border-white/[0.06] py-3">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-white/40">
                  Studio{studios.length > 1 ? "s" : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {studios.slice(0, 6).map((s) => {
                    const companyLogo = logoUrl(s.logo_path, "w185");
                    return (
                      <span
                        key={s.id}
                        className="flex items-center gap-2 rounded-2xl bg-white/[0.06] py-1.5 pl-1.5 pr-3 ring-1 ring-white/10"
                      >
                        {companyLogo ? (
                          <span className="flex h-8 w-12 items-center justify-center overflow-hidden rounded-xl bg-white p-1">
                            <Image
                              src={companyLogo}
                              alt={`${s.name} logo`}
                              width={48}
                              height={32}
                              className="h-full w-full object-contain"
                              unoptimized
                            />
                          </span>
                        ) : (
                          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/10">
                            <Building2 className="h-4 w-4 text-white/60" />
                          </span>
                        )}
                        <span className="max-w-[8rem] truncate text-xs font-semibold text-white/85">
                          {s.name}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Top-billed cast */}
        {cast.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2.5 text-[22px] font-extrabold tracking-tight text-white">
              Cast
            </h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-none">
              {cast.map((person) => {
                const photo = posterUrl(person.profile_path, "w185");
                return (
                  <Link
                    key={person.id}
                    href={`/person/${person.id}`}
                    className="w-28 flex-shrink-0"
                  >
                    <div className="relative aspect-square overflow-hidden rounded-full bg-secondary ring-1 ring-white/10">
                      {photo ? (
                        <Image
                          src={photo}
                          alt={person.name}
                          fill
                          sizes="112px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xl font-black text-white/30">
                          {person.name.charAt(0)}
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 truncate text-center text-xs font-semibold leading-tight text-white/90">
                      {person.name}
                    </p>
                    {person.character && (
                      <p className="truncate text-center text-[11px] leading-tight text-white/40">
                        {person.character}
                      </p>
                    )}
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* ---------- Stickers ---------- */}
        {stickers.length > 0 && (
          <section className="mt-7">
            <div className="mb-1 flex items-center gap-1">
              <h2 className="text-[22px] font-extrabold tracking-tight text-white">
                Stickers
              </h2>
              <ChevronRight className="h-5 w-5 text-white/35" />
            </div>
            <div className="flex items-end gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {stickers.map((src, i) => {
                const hero = i === stickers.length - 1 && stickers.length > 3;
                return (
                  <div
                    key={src}
                    className="sticker-art shrink-0"
                    style={{
                      transform: `rotate(${i % 3 === 0 ? -3 : i % 3 === 1 ? 2 : -1}deg)`,
                    }}
                  >
                    <Image
                      src={src}
                      alt=""
                      width={hero ? 240 : 180}
                      height={hero ? 240 : 180}
                      sizes={
                        hero
                          ? "(min-width: 640px) 240px"
                          : "(min-width: 640px) 180px"
                      }
                      className={`w-auto object-contain ${hero ? "h-[180px]" : "h-[135px]"}`}
                      unoptimized
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="mt-5">
          <WatchProviders providers={providers} />
        </div>

        <CommunityReviews payload={reviews} />

        <div className="mt-6">
          <DiscoverRail label="You Might Also Like" items={moreLikeThis} />
          <DiscoverRail label="Recommended for you" items={recommended} />
        </div>

        {trailerKey && (
          <a
            href={`https://www.youtube.com/watch?v=${trailerKey}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 flex items-center justify-center gap-1 text-xs font-semibold text-white/35 transition hover:text-white/70"
          >
            More trailers on YouTube
            <ChevronRight className="h-3.5 w-3.5" />
          </a>
        )}
        {/* ---------- Information: Apple-style fact sheet, always last ---------- */}
        <InfoList
          className="mt-7"
          items={
            [
              { label: "Title", value: movie.title },
              releaseLabel && { label: "Released", value: releaseLabel },
              {
                label: "Rated",
                value: certification
                  ? certification.code
                  : isAdult
                    ? "Adult · 18+"
                    : "Not rated",
              },
              productionCountries.length > 0 && {
                label: "Region of Origin",
                value: productionCountries
                  .slice(0, 2)
                  .map((c) => c.name)
                  .join(", "),
              },
              language && { label: "Original Audio", value: language },
              runtimeLabel && { label: "Runtime", value: runtimeLabel },
              status && { label: "Status", value: status },
              studios.length > 0 && {
                label: studios.length > 1 ? "Studios" : "Studio",
                value: studios
                  .slice(0, 2)
                  .map((s) => s.name)
                  .join(", "),
              },
            ].filter(Boolean) as InfoListItem[]
          }
        />

      </div>
    </div>
    </>
  );
}
