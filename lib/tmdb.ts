const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

function getApiKey() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    throw new Error("TMDB_API_KEY is not set");
  }
  return key;
}

export async function tmdbFetch<T>(
  path: string,
  params: Record<string, string> = {},
  opts?: { revalidate?: number }
): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.append("api_key", getApiKey());
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const ctrl = AbortSignal.timeout(10_000);
  const res = await fetch(url.toString(), {
    // Default 1h; hot paths (trending) can pass a shorter window
    next: { revalidate: opts?.revalidate ?? 3600 },
    signal: ctrl,
  });
  if (!res.ok) {
    throw new Error(`TMDB API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function posterUrl(
  path: string | null | undefined,
  size: "w92" | "w154" | "w185" | "w342" | "w500" | "w780" | "original" = "w500"
) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export function backdropUrl(
  path: string | null | undefined,
  size: "w300" | "w780" | "w1280" | "original" = "w1280"
) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export function stillUrl(
  path: string | null | undefined,
  size: "w92" | "w185" | "w300" | "original" = "w300"
) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export async function searchTv(query: string, page = 1) {
  return tmdbFetch<{
    page: number;
    results: Array<{
      id: number;
      name: string;
      first_air_date?: string;
      poster_path?: string;
      overview?: string;
      popularity?: number;
    }>;
    total_pages: number;
    total_results: number;
  }>("/search/tv", { query, page: page.toString() });
}

export async function searchMovie(query: string, page = 1) {
  return tmdbFetch<{
    page: number;
    results: Array<{
      id: number;
      title: string;
      release_date?: string;
      poster_path?: string;
      overview?: string;
      popularity?: number;
    }>;
    total_pages: number;
    total_results: number;
  }>("/search/movie", { query, page: page.toString() });
}

export async function getTvDetails(tmdbId: number) {
  return tmdbFetch<{
    id: number;
    name: string;
    overview?: string;
    poster_path?: string;
    backdrop_path?: string;
    first_air_date?: string;
    last_air_date?: string;
    status?: string;
    networks?: Array<{ name: string }>;
    number_of_seasons?: number;
    number_of_episodes?: number;
    episode_run_time?: number[];
    vote_average?: number;
    original_language?: string;
    origin_country?: string[];
    production_countries?: TmdbCountry[];
    type?: string;
    tagline?: string;
    genres?: TmdbGenre[];
  }>(`/tv/${tmdbId}`);
}

/** /tv/{id}/content_ratings — one rating per region, e.g. US → "TV-MA". */
export async function getTvContentRatings(tmdbId: number) {
  const data = await tmdbFetch<{
    results?: Array<{ iso_3166_1?: string; rating?: string }>;
  }>(`/tv/${tmdbId}/content_ratings`, {}, { revalidate: 86400 });
  return data.results ?? [];
}

export function pickTvRating(
  ratings: Array<{ iso_3166_1?: string; rating?: string }> | null | undefined,
  region?: string
): string | null {
  if (!ratings?.length) return null;
  const wanted = [region?.toUpperCase(), "US"].filter(Boolean) as string[];
  const byIso = new Map(
    ratings.filter((r) => r.iso_3166_1).map((r) => [r.iso_3166_1!, r])
  );
  for (const iso of [...wanted, ...ratings.map((r) => r.iso_3166_1 ?? "")]) {
    const hit = iso ? byIso.get(iso) : undefined;
    if (hit?.rating?.trim()) return hit.rating.trim();
  }
  return null;
}

export async function getTvSeason(tmdbId: number, seasonNumber: number) {
  return tmdbFetch<{
    id: number;
    name: string;
    season_number: number;
    episodes: Array<{
      id: number;
      name: string;
      overview?: string;
      episode_number: number;
      season_number: number;
      still_path?: string;
      air_date?: string;
      runtime?: number;
    }>;
  }>(`/tv/${tmdbId}/season/${seasonNumber}`);
}

export type TmdbGenre = { id: number; name: string };

export type TmdbCompany = {
  id: number;
  name: string;
  logo_path?: string | null;
  origin_country?: string;
};

export type TmdbCountry = {
  iso_3166_1: string;
  name: string;
};

export type MovieDetails = {
  id: number;
  title: string;
  overview?: string;
  tagline?: string;
  poster_path?: string;
  backdrop_path?: string;
  release_date?: string;
  runtime?: number;
  status?: string;
  vote_average?: number;
  vote_count?: number;
  budget?: number;
  revenue?: number;
  imdb_id?: string | null;
  original_language?: string;
  adult?: boolean;
  genres?: TmdbGenre[];
  production_companies?: TmdbCompany[];
  production_countries?: TmdbCountry[];
};

export async function getMovieDetails(
  tmdbId: number
): Promise<MovieDetails> {
  return tmdbFetch<MovieDetails>(`/movie/${tmdbId}`);
}

export type TmdbCrewMember = {
  job?: string;
  department?: string;
  name?: string;
  id?: number;
};

export async function getMovieCredits(tmdbId: number) {
  return tmdbFetch<{
    id: number;
    cast: Array<{
      id: number;
      name: string;
      character?: string;
      order?: number;
      profile_path?: string | null;
    }>;
    crew: TmdbCrewMember[];
  }>(`/movie/${tmdbId}/credits`, {}, { revalidate: 86400 });
}

/** Director names from TMDB movie credits crew. */
export function movieDirectors(crew: TmdbCrewMember[] | null | undefined): string[] {
  if (!crew?.length) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const c of crew) {
    if (c.job !== "Director" || !c.name) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    names.push(c.name);
  }
  return names;
}

export type TmdbCastMember = {
  id: number;
  name: string;
  character?: string;
  order?: number;
  profile_path?: string | null;
};

/** Show cast, ordered like TMDB already sorts it (billed order). */
export async function getTvCredits(tmdbId: number) {
  const data = await tmdbFetch<{
    cast: TmdbCastMember[];
    crew: TmdbCrewMember[];
  }>(`/tv/${tmdbId}/credits`, {}, { revalidate: 86400 });
  return {
    cast: data.cast ?? [],
    crew: data.crew ?? [],
  };
}

/** Creator names from TMDB TV credits crew. */
export function tvCreators(crew: TmdbCrewMember[] | null | undefined): string[] {
  if (!crew?.length) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const c of crew) {
    if (c.job !== "Creator" || !c.name) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    names.push(c.name);
  }
  return names;
}

/**
 * `tvdb_id` is what Fanart's `/v3/tv/{id}` endpoint actually wants — feeding it
 * a TMDB id answers `200 {}` (no error, no artwork), which then gets cached for
 * a day. Returns `null` for shows with no TVDB mapping, so callers skip Fanart.
 */
export async function getTvExternalIds(
  tmdbId: number
): Promise<{ imdb_id?: string | null; tvdb_id?: number | null }> {
  return tmdbFetch<{ imdb_id?: string | null; tvdb_id?: number | null }>(
    `/tv/${tmdbId}/external_ids`
  );
}

export async function getMovieExternalIds(tmdbId: number) {
  return tmdbFetch<{ imdb_id?: string | null }>(`/movie/${tmdbId}/external_ids`);
}

export type TmdbVideo = {
  id: string;
  key: string;
  site?: string;
  type?: string;
  official?: boolean;
  name?: string;
  published_at?: string;
};

export async function getMovieVideos(tmdbId: number) {
  const data = await tmdbFetch<{ results: TmdbVideo[] }>(
    `/movie/${tmdbId}/videos`,
    {},
    { revalidate: 86400 }
  );
  return data.results ?? [];
}

export async function getTvVideos(tmdbId: number) {
  const data = await tmdbFetch<{ results: TmdbVideo[] }>(
    `/tv/${tmdbId}/videos`,
    {},
    { revalidate: 86400 }
  );
  return data.results ?? [];
}

/** Best YouTube trailer key: official Trailer first, then any Trailer, then Teaser. */
export function pickTrailerKey(videos: TmdbVideo[]): string | null {
  const yt = videos.filter((v) => v.site === "YouTube" && v.key);
  if (yt.length === 0) return null;
  const rank = (v: TmdbVideo) =>
    (v.type === "Trailer" ? 2 : v.type === "Teaser" ? 1 : 0) * 10 +
    (v.official ? 1 : 0);
  yt.sort((a, b) => rank(b) - rank(a));
  return yt[0].key;
}

export type TmdbReview = {
  id: string;
  author: string;
  content: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  author_details?: {
    name?: string;
    username?: string;
    avatar_path?: string | null;
    rating?: number | null;
  };
};

export async function getMovieReviews(tmdbId: number, page = 1) {
  return tmdbFetch<{
    id: number;
    page: number;
    results: TmdbReview[];
    total_pages: number;
    total_results: number;
  }>(`/movie/${tmdbId}/reviews`, { page: String(page) }, { revalidate: 3600 });
}

export async function getTvReviews(tmdbId: number, page = 1) {
  return tmdbFetch<{
    id: number;
    page: number;
    results: TmdbReview[];
    total_pages: number;
    total_results: number;
  }>(`/tv/${tmdbId}/reviews`, { page: String(page) }, { revalidate: 3600 });
}

/** Trending revalidates every 15m so Explore feels fresher. */
const TRENDING_REVALIDATE = 900;

export async function getTrendingTv(timeWindow: "day" | "week" = "week") {
  return tmdbFetch<{
    results: Array<{
      id: number;
      name: string;
      poster_path?: string;
      backdrop_path?: string;
      overview?: string;
      vote_average?: number;
    }>;
  }>(`/trending/tv/${timeWindow}`, {}, { revalidate: TRENDING_REVALIDATE });
}

export async function getTrendingMovies(timeWindow: "day" | "week" = "week") {
  return tmdbFetch<{
    results: Array<{
      id: number;
      title: string;
      poster_path?: string;
      backdrop_path?: string;
      overview?: string;
      vote_average?: number;
    }>;
  }>(`/trending/movie/${timeWindow}`, {}, { revalidate: TRENDING_REVALIDATE });
}

export async function getPopularMovies() {
  return tmdbFetch<{
    results: Array<{
      id: number;
      title: string;
      poster_path?: string;
      backdrop_path?: string;
    }>;
  }>("/movie/popular");
}

export async function getAiringToday() {
  return tmdbFetch<{
    results: Array<{
      id: number;
      name: string;
      poster_path?: string;
      backdrop_path?: string;
    }>;
  }>("/tv/airing_today");
}

export async function getOnTheAir() {
  return tmdbFetch<{
    results: Array<{
      id: number;
      name: string;
      poster_path?: string;
      backdrop_path?: string;
      first_air_date?: string;
    }>;
  }>("/tv/on_the_air");
}

export type TmdbMediaCard = {
  id: number;
  title: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string | null;
  mediaType: "tv" | "movie";
  vote_average?: number;
  badge?: string;
};

type TmdbListItem = {
  id: number;
  name?: string;
  title?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string | null;
  vote_average?: number;
  vote_count?: number;
};

function mapList(
  results: TmdbListItem[],
  mediaType: "tv" | "movie"
): TmdbMediaCard[] {
  return results.map((r) => ({
    id: r.id,
    title: (mediaType === "tv" ? r.name : r.title) || "Untitled",
    poster_path: r.poster_path,
    backdrop_path: r.backdrop_path,
    overview: r.overview,
    mediaType,
    vote_average: r.vote_average,
  }));
}

export async function getTrendingTvCards(
  timeWindow: "day" | "week" = "week"
): Promise<TmdbMediaCard[]> {
  const data = await getTrendingTv(timeWindow);
  return mapList(
    (data.results ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      poster_path: s.poster_path,
      backdrop_path: s.backdrop_path,
      overview: s.overview,
      vote_average: s.vote_average,
    })),
    "tv"
  );
}

export async function getTrendingMovieCards(
  timeWindow: "day" | "week" = "week"
): Promise<TmdbMediaCard[]> {
  const data = await getTrendingMovies(timeWindow);
  return mapList(
    (data.results ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      poster_path: m.poster_path,
      backdrop_path: m.backdrop_path,
      overview: m.overview,
      vote_average: m.vote_average,
    })),
    "movie"
  );
}

export async function getAiringTodayCards(): Promise<TmdbMediaCard[]> {
  const data = await getAiringToday();
  return mapList(
    (data.results ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      poster_path: s.poster_path,
      backdrop_path: s.backdrop_path,
    })),
    "tv"
  );
}

export async function getOnTheAirCards(): Promise<TmdbMediaCard[]> {
  const data = await getOnTheAir();
  return mapList(
    (data.results ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      poster_path: s.poster_path,
    })),
    "tv"
  );
}

export async function getTvRecommendations(tmdbId: number) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>(
    `/tv/${tmdbId}/recommendations`
  );
  return mapList(data.results ?? [], "tv");
}

export async function getTvSimilar(tmdbId: number) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>(
    `/tv/${tmdbId}/similar`
  );
  return mapList(data.results ?? [], "tv");
}

export async function getMovieRecommendations(tmdbId: number) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>(
    `/movie/${tmdbId}/recommendations`
  );
  return mapList(data.results ?? [], "movie");
}

export async function getMovieSimilar(tmdbId: number) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>(
    `/movie/${tmdbId}/similar`
  );
  return mapList(data.results ?? [], "movie");
}

export async function getTopRatedTv() {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/tv/top_rated");
  return mapList(data.results ?? [], "tv");
}

export async function getTopRatedMovies() {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/movie/top_rated");
  return mapList(data.results ?? [], "movie");
}

export type TmdbMovieCard = TmdbMediaCard & {
  release_date?: string | null;
  overview?: string | null;
  vote_count?: number;
};

function mapMovieCards(
  results: Array<
    TmdbListItem & { release_date?: string; overview?: string }
  >
): TmdbMovieCard[] {
  return (results ?? []).map((r) => ({
    id: r.id,
    title: r.title || r.name || "Untitled",
    poster_path: r.poster_path,
    backdrop_path: r.backdrop_path,
    mediaType: "movie" as const,
    vote_average: r.vote_average,
    vote_count: r.vote_count,
    release_date: r.release_date ?? null,
    overview: r.overview ?? null,
  }));
}

/** Paginated top-rated movies (TMDB ~20 per page). */
export async function getTopRatedMoviesPage(page = 1): Promise<TmdbMovieCard[]> {
  const data = await tmdbFetch<{
    results: Array<
      TmdbListItem & { release_date?: string; overview?: string }
    >;
  }>("/movie/top_rated", { page: String(page) });
  return mapMovieCards(data.results ?? []);
}

/**
 * Highly rated "classics" — strong scores + real vote volume.
 * Optional max year biases toward older films when set.
 * `sortBy` rotates per week so different populations surface (vote avg,
 * popularity, revenue, vote count, release date) instead of the same
 * top-rated wall every single time.
 */
export async function discoverGreatMovies(
  page = 1,
  opts?: {
    maxYear?: number;
    minYear?: number;
    minVoteAverage?: number;
    minVoteCount?: number;
    maxVoteCount?: number;
    /** ISO 639-1 code(s), e.g. "ja" or "fr|ko" — for world-cinema slices */
    originalLanguage?: string;
    sortBy?:
      | "vote_average.desc"
      | "popularity.desc"
      | "revenue.desc"
      | "vote_count.desc"
      | "primary_release_date.desc";
    withGenres?: string;
  }
): Promise<TmdbMovieCard[]> {
  const maxYear = opts?.maxYear;
  const minVote = opts?.minVoteAverage ?? 7.5;
  const data = await tmdbFetch<{
    results: Array<
      TmdbListItem & { release_date?: string; overview?: string }
    >;
  }>("/discover/movie", {
    sort_by: opts?.sortBy ?? "vote_average.desc",
    "vote_count.gte": String(opts?.minVoteCount ?? 800),
    "vote_average.gte": String(minVote),
    ...(opts?.maxVoteCount
      ? { "vote_count.lte": String(opts.maxVoteCount) }
      : {}),
    ...(maxYear
      ? { "primary_release_date.lte": `${maxYear}-12-31` }
      : {}),
    ...(opts?.minYear
      ? { "primary_release_date.gte": `${opts.minYear}-01-01` }
      : {}),
    ...(opts?.originalLanguage
      ? { with_original_language: opts.originalLanguage }
      : {}),
    ...(opts?.withGenres ? { with_genres: opts.withGenres } : {}),
    page: String(page),
    include_adult: "false",
  });
  return mapMovieCards(data.results ?? []);
}

export async function getNowPlayingMovies() {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/movie/now_playing");
  return mapList(data.results ?? [], "movie");
}

/** Movies opening soon (theatrical). */
export async function getUpcomingMovies() {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/movie/upcoming");
  return mapList(data.results ?? [], "movie");
}

/**
 * True upcoming pipeline: unreleased movies, most-anticipated first.
 * NOTE: /movie/upcoming page 1 is mostly already-released holdovers, so we
 * use discover sorted by popularity with a release-date floor instead.
 */
export async function discoverUpcomingMovies(
  minReleaseDate: string,
  page = 1
): Promise<TmdbMovieCard[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minReleaseDate)) {
    throw new Error("invalid minReleaseDate (expected YYYY-MM-DD)");
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) {
    throw new Error("invalid page");
  }
  const data = await tmdbFetch<{
    results: Array<TmdbListItem & { release_date?: string; overview?: string }>;
  }>("/discover/movie", {
    sort_by: "popularity.desc",
    "primary_release_date.gte": minReleaseDate,
    page: String(page),
    include_adult: "false",
    "vote_count.gte": "10",
  });
  return mapMovieCards(data.results ?? []);
}

export async function getPopularTv() {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/tv/popular");
  return mapList(data.results ?? [], "tv");
}

/** Higher-quality discover: min votes so junk is filtered out. */
export async function discoverTvPopular(
  opts: { withGenres?: number; page?: number } = {}
) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/discover/tv", {
    sort_by: "popularity.desc",
    "vote_count.gte": "50",
    ...(opts.withGenres != null
      ? { with_genres: String(opts.withGenres) }
      : {}),
    page: String(opts.page ?? 1),
  });
  return mapList(data.results ?? [], "tv");
}

export async function discoverMoviePopular(
  opts: { withGenres?: number; page?: number } = {}
) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/discover/movie", {
    sort_by: "popularity.desc",
    "vote_count.gte": "80",
    ...(opts.withGenres != null
      ? { with_genres: String(opts.withGenres) }
      : {}),
    page: String(opts.page ?? 1),
  });
  return mapList(data.results ?? [], "movie");
}

export async function discoverTvByGenre(genreId: number, page = 1) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/discover/tv", {
    with_genres: String(genreId),
    sort_by: "popularity.desc",
    page: String(page),
  });
  return mapList(data.results ?? [], "tv");
}

export async function discoverMoviesByGenre(genreId: number, page = 1) {
  const data = await tmdbFetch<{ results: TmdbListItem[] }>("/discover/movie", {
    with_genres: String(genreId),
    sort_by: "popularity.desc",
    page: String(page),
  });
  return mapList(data.results ?? [], "movie");
}

/** Ranked best of a single year — Letterboxd-style year page backend.
 * vote_average.desc with vote-count floor so the ranking is best-first,
 * not popularity-first. Recent years get looser floors (votes still
 * accumulating). Returns page totals for pagination UI. */
export async function discoverMoviesByYear(
  year: number,
  page = 1,
  opts?: { minVoteAverage?: number; minVoteCount?: number }
): Promise<{ items: TmdbMovieCard[]; totalPages: number; totalResults: number }> {
  const currentYear = new Date().getFullYear();
  const isRecent = year >= currentYear - 1;
  const data = await tmdbFetch<{
    results: Array<TmdbListItem & { release_date?: string; overview?: string }>;
    total_pages?: number;
    total_results?: number;
  }>("/discover/movie", {
    sort_by: "vote_average.desc",
    primary_release_year: String(year),
    "vote_count.gte": String(opts?.minVoteCount ?? (isRecent ? 50 : 300)),
    "vote_average.gte": String(opts?.minVoteAverage ?? (isRecent ? 6.0 : 7.0)),
    page: String(page),
    include_adult: "false",
  });
  return {
    items: mapMovieCards(data.results ?? []),
    totalPages: data.total_pages ?? 1,
    totalResults: data.total_results ?? 0,
  };
}

/** Best of a decade — same ranked engine over a 10-year window. */
export async function discoverMoviesByDecade(
  startYear: number,
  page = 1,
  opts?: { minVoteAverage?: number; minVoteCount?: number }
): Promise<{ items: TmdbMovieCard[]; totalPages: number; totalResults: number }> {
  const data = await tmdbFetch<{
    results: Array<TmdbListItem & { release_date?: string; overview?: string }>;
    total_pages?: number;
    total_results?: number;
  }>("/discover/movie", {
    sort_by: "vote_average.desc",
    "primary_release_date.gte": `${startYear}-01-01`,
    "primary_release_date.lte": `${startYear + 9}-12-31`,
    "vote_count.gte": String(opts?.minVoteCount ?? 300),
    "vote_average.gte": String(opts?.minVoteAverage ?? 7.0),
    page: String(page),
    include_adult: "false",
  });
  return {
    items: mapMovieCards(data.results ?? []),
    totalPages: data.total_pages ?? 1,
    totalResults: data.total_results ?? 0,
  };
}

export type TmdbPersonDetails = {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  known_for_department?: string;
  popularity?: number;
};

export async function getPersonDetails(
  personId: number
): Promise<TmdbPersonDetails> {
  return tmdbFetch<TmdbPersonDetails>(`/person/${personId}`, {}, { revalidate: 86400 });
}

export type TmdbPersonMovieCredit = {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  release_date?: string;
  character?: string;
  job?: string;
  department?: string;
};

export async function getPersonMovieCredits(personId: number): Promise<{
  cast: TmdbPersonMovieCredit[];
  crew: TmdbPersonMovieCredit[];
}> {
  const data = await tmdbFetch<{
    cast?: TmdbPersonMovieCredit[];
    crew?: TmdbPersonMovieCredit[];
  }>(`/person/${personId}/movie_credits`, {}, { revalidate: 86400 });
  return { cast: data.cast ?? [], crew: data.crew ?? [] };
}

/**
 * Acting + crew work across movies *and* series. Unlike `movie_credits` this
 * carries `media_type` and `first_air_date`, which is what the person page
 * needs to split the filmography and to compute the seen ratio.
 */
export type TmdbCombinedCredit = {
  credit_id?: string;
  id: number;
  media_type?: "movie" | "tv" | string;
  /** Movie field */
  title?: string;
  /** TV field */
  name?: string;
  character?: string;
  job?: string;
  department?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  /** Movie field */
  release_date?: string;
  /** TV field */
  first_air_date?: string;
  episode_count?: number;
  order?: number;
};

export async function getPersonCombinedCredits(personId: number): Promise<{
  cast: TmdbCombinedCredit[];
  crew: TmdbCombinedCredit[];
}> {
  const data = await tmdbFetch<{
    cast?: TmdbCombinedCredit[];
    crew?: TmdbCombinedCredit[];
  }>(`/person/${personId}/combined_credits`, {}, { revalidate: 86400 });
  return { cast: data.cast ?? [], crew: data.crew ?? [] };
}

export type WatchProvider = {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
};

export type WatchProvidersResult = {
  link?: string;
  flatrate: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
};

function mapProviders(
  list:
    | Array<{
        provider_id: number;
        provider_name: string;
        logo_path?: string | null;
      }>
    | undefined
): WatchProvider[] {
  return (list ?? []).map((p) => ({
    provider_id: p.provider_id,
    provider_name: p.provider_name,
    logo_path: p.logo_path ?? null,
  }));
}

/** Where to watch. Region from WATCH_REGION env (default NG). */
export async function getWatchProviders(
  tmdbId: number,
  type: "tv" | "movie"
): Promise<WatchProvidersResult> {
  const region = (process.env.WATCH_REGION || "NG").toUpperCase();
  const data = await tmdbFetch<{
    results?: Record<
      string,
      {
        link?: string;
        flatrate?: Array<{
          provider_id: number;
          provider_name: string;
          logo_path?: string | null;
        }>;
        rent?: Array<{
          provider_id: number;
          provider_name: string;
          logo_path?: string | null;
        }>;
        buy?: Array<{
          provider_id: number;
          provider_name: string;
          logo_path?: string | null;
        }>;
      }
    >;
  }>(`/${type}/${tmdbId}/watch/providers`);

  const entry = data.results?.[region] ?? data.results?.US;
  if (!entry) return { flatrate: [], rent: [], buy: [] };
  return {
    link: entry.link,
    flatrate: mapProviders(entry.flatrate),
    rent: mapProviders(entry.rent),
    buy: mapProviders(entry.buy),
  };
}

export type TmdbLogo = {
  file_path: string;
  iso_639_1?: string | null;
  width?: number;
  height?: number;
  vote_average?: number;
  vote_count?: number;
};

export function logoUrl(
  path: string | null | undefined,
  size: "w154" | "w185" | "w300" | "w500" | "original" = "w500"
) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

/**
 * Title treatments in the film's original font (TMDB /movie/{id}/images).
 * Prefer English artwork with the most votes, fall back to anything.
 */
export async function getMovieImages(tmdbId: number): Promise<{
  logos: TmdbLogo[];
}> {
  const data = await tmdbFetch<{ logos?: TmdbLogo[] }>(
    `/movie/${tmdbId}/images`,
    {},
    { revalidate: 86400 }
  );
  return { logos: data.logos ?? [] };
}

export function pickMovieLogo(logos: TmdbLogo[] | null | undefined): string | null {
  if (!logos?.length) return null;
  const ranked = [...logos].sort(
    (a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0)
  );
  const en = ranked.find((l) => l.iso_639_1 === "en");
  return (en ?? ranked[0]).file_path ?? null;
}

/**
 * Title treatments in the show's original font (TMDB /tv/{id}/images).
 * Same shape and ranking as movies.
 */
export async function getTvImages(tmdbId: number): Promise<{
  logos: TmdbLogo[];
}> {
  const data = await tmdbFetch<{ logos?: TmdbLogo[] }>(
    `/tv/${tmdbId}/images`,
    {},
    { revalidate: 86400 }
  );
  return { logos: data.logos ?? [] };
}

export type TmdbReleaseInfo = {
  certification?: string;
  iso_639_1?: string | null;
  note?: string;
  release_date?: string;
  type?: number;
};

export type TmdbReleaseCountry = {
  iso_3166_1: string;
  release_dates: TmdbReleaseInfo[];
};

/**
 * Parental-guide source: /movie/{id}/release_dates.
 * Prefers US theatrical, then the app region, then anything rated.
 */
export async function getMovieReleaseDates(
  tmdbId: number
): Promise<TmdbReleaseCountry[]> {
  const data = await tmdbFetch<{ results?: TmdbReleaseCountry[] }>(
    `/movie/${tmdbId}/release_dates`,
    {},
    { revalidate: 86400 }
  );
  return data.results ?? [];
}

export function pickCertification(
  countries: TmdbReleaseCountry[] | null | undefined,
  region?: string
): { code: string; country: string } | null {
  if (!countries?.length) return null;
  const wanted = [region?.toUpperCase(), "US"].filter(Boolean) as string[];
  const byIso = new Map(countries.map((c) => [c.iso_3166_1, c]));
  const ordered = [
    ...wanted.map((iso) => byIso.get(iso)).filter(Boolean),
    ...countries,
  ] as TmdbReleaseCountry[];
  for (const entry of ordered) {
    const rated = (entry.release_dates ?? []).filter(
      (r) => r.certification && r.certification.trim().length > 0
    );
    if (rated.length === 0) continue;
    // Theatrical (3) first, then digital (4), premiere (1), limited (2)…
    rated.sort((a, b) => {
      const rank = (t?: number) => (t === 3 ? 0 : t === 4 ? 1 : 2);
      return rank(a.type) - rank(b.type);
    });
    return { code: rated[0].certification!.trim(), country: entry.iso_3166_1 };
  }
  return null;
}

/** ISO-639-1 → English language name ("en" → "English"). */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(code) ??
      code.toUpperCase()
    );
  } catch {
    return code.toUpperCase();
  }
}

export function providerLogoUrl(path: string | null | undefined) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE_URL}/w92${path}`;
}

export const TV_GENRES = [
  { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 80, name: "Crime" },
  { id: 18, name: "Drama" },
  { id: 35, name: "Comedy" },
  { id: 16, name: "Animation" },
  { id: 10759, name: "Action & Adventure" },
] as const;

export const MOVIE_GENRES = [
  { id: 28, name: "Action" },
  { id: 878, name: "Science Fiction" },
  { id: 80, name: "Crime" },
  { id: 18, name: "Drama" },
  { id: 35, name: "Comedy" },
  { id: 27, name: "Horror" },
] as const;
