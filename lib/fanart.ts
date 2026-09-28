/**
 * Fanart.tv artwork for show and movie detail.
 *
 * Shows — `getShowLogoArt` / `getShowStickers` / `getShowClearart`
 * Movies — `getMovieStickers` / `getMovieLogoArt`
 *
 * NOTE: the show helpers take a **TheTVDB** id, not a TMDB id. Fanart answers
 * `200 {}` for an id it doesn't know, which looks like "no artwork" and gets
 * cached for a day — resolve it with `getTvExternalIds(tmdbId).tvdb_id` first.
 * The movie helpers take the **TMDB** id, which is what `/v3/movies/{id}`
 * expects, so they need no lookup.
 *
 * Everything else (posters, backdrops) stays on TMDB so `posterPath`/`backdropPath`
 * keep feeding the grid, list rows and `lib/movie-theme.ts` untouched.
 *
 * Free project key via FANART_API_KEY. Missing key, missing artwork, 401 or 404
 * all resolve to `null` — callers fall back to TMDB, never to a broken image.
 *
 * Attribution: public apps must credit https://fanart.tv (see FANART_CREDIT_URL).
 */

export const FANART_CREDIT_URL = "https://fanart.tv";

const FANART_BASE_URL = "https://webservice.fanart.tv/v3";

export type FanartImage = {
  id: string;
  lang?: string;
  likes?: string | number;
  url: string;
};

type FanartTvArt = {
  clearlogo?: FanartImage[];
  hdtvlogo?: FanartImage[];
  clearart?: FanartImage[];
  hdclearart?: FanartImage[];
  characterart?: FanartImage[];
  hdmovieclearart?: FanartImage[];
  hdmovielogo?: FanartImage[];
  movieart?: FanartImage[];
};

function getApiKey(): string | null {
  const key = process.env.FANART_API_KEY?.trim();
  return key ? key : null;
}

async function fanartFetch(kind: "tv" | "movies", id: number): Promise<FanartTvArt> {
  const key = getApiKey();
  if (!key || !Number.isFinite(id) || id <= 0) return {};

  try {
    const url = new URL(`${FANART_BASE_URL}/${kind}/${id}`);
    url.searchParams.set("api_key", key);
    const res = await fetch(url.toString(), {
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(10_000),
    });
    // Unknown shows answer 200 with `{}`; bad/expired keys answer 401.
    if (!res.ok) return {};
    const data = (await res.json()) as FanartTvArt;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** Most-liked entry, preferring the given language tags ("" = language-neutral). */
function pickBest(
  images: FanartImage[] | undefined,
  langs: string[]
): string | null {
  if (!images?.length) return null;
  const ranked = images
    .filter((i) => i?.url)
    .sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0));
  for (const lang of langs) {
    const hit = ranked.find((i) => (i.lang ?? "") === lang);
    if (hit) return hit.url;
  }
  return ranked[0]?.url ?? null;
}

/**
 * Original-font title treatment with a real alpha channel, so the hero's
 * `drop-shadow` reads as a cut-out instead of a rectangle.
 */
export async function getShowLogoArt(tvdbId: number): Promise<string | null> {
  const art = await fanartFetch("tv", tvdbId);
  return (
    pickBest(art.clearlogo, ["en", ""]) ?? pickBest(art.hdtvlogo, ["en", ""])
  );
}

/**
 * Transparent character cut-outs — the Stickers section.
 * `characterart` is one figure per image (sticker-shaped); `hdclearart` /
 * `clearart` are ensemble word-art used when a show has no character art.
 */
export async function getShowStickers(tvdbId: number): Promise<string[]> {
  const art = await fanartFetch("tv", tvdbId);
  const ranked = (list: FanartImage[] | undefined) =>
    (list ?? [])
      .filter((i) => i?.url)
      .sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0));

  const preferred = [
    ...ranked(art.characterart).filter((i) => (i.lang ?? "") === "en" || (i.lang ?? "") === ""),
    ...ranked(art.characterart).filter((i) => (i.lang ?? "") !== "en" && (i.lang ?? "") !== ""),
  ];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const img of preferred) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img.url);
    if (out.length >= 12) return out;
  }

  // Ensemble art keeps the section alive for shows with no character cut-outs.
  const ensemble =
    pickBest(art.hdclearart, ["en", ""]) ?? pickBest(art.clearart, ["en", ""]);
  if (ensemble && !seen.has(ensemble)) out.push(ensemble);

  return out;
}

/**
 * Ensemble character word-art used as the section's hero piece when it isn't
 * already in the sticker list.
 */
export async function getShowClearart(tvdbId: number): Promise<string | null> {
  const art = await fanartFetch("tv", tvdbId);
  return (
    pickBest(art.hdclearart, ["en", ""]) ?? pickBest(art.clearart, ["en", ""])
  );
}

/* ── Movies ────────────────────────────────────────────────────── */

/**
 * Transparent character/title cut-outs for a movie's Stickers section.
 *
 * Unlike `/v3/tv/{id}`, Fanart's `/v3/movies/{id}` takes the **TMDB** id, so no
 * external-id lookup is needed. `hdmovieclearart` is the character-art plate;
 * `movieart` is the rarer legacy key and is appended so nothing is dropped.
 */
export async function getMovieStickers(tmdbId: number): Promise<string[]> {
  const art = await fanartFetch("movies", tmdbId);
  const ranked = (list: FanartImage[] | undefined) =>
    (list ?? [])
      .filter((i) => i?.url)
      .sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const img of [
    ...ranked(art.hdmovieclearart),
    ...ranked(art.movieart),
  ]) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img.url);
    if (out.length >= 12) break;
  }
  return out;
}

/** Original-font movie wordmark with a real alpha channel. */
export async function getMovieLogoArt(tmdbId: number): Promise<string | null> {
  const art = await fanartFetch("movies", tmdbId);
  return (
    pickBest(art.hdmovielogo, ["en", ""]) ?? pickBest(art.hdmovielogo, ["", "en"])
  );
}
