/**
 * Movie of the Night "Streaming Availability" — the Where-to-watch card.
 *
 * `GET https://api.movieofthenight.com/v4/shows/tv/{tmdbId}?country={cc}`
 * authenticated with `X-API-Key`. Returns per-service deep links, video
 * quality, price and expiry, which TMDB's JustWatch feed does not carry.
 *
 * Free plan is capped at ~1,000 requests/month, so everything is cached in
 * `tmdb_list_cache` for a week with stale-while-revalidate: the first visitor
 * after the TTL still renders instantly while the refresh happens behind them.
 *
 * Every failure path (no key, timeout, unsupported country, quota) resolves to
 * `null` so the page falls back to the TMDB watch-providers card it already has.
 */

import { eq } from "drizzle-orm";
import { db, withDbRetry } from "./db";
import { tmdbListCache } from "./schema";

const MOTN_BASE_URL = "https://api.movieofthenight.com/v4";

/** Availability shifts slowly; 7d keeps a 1,000-req/month budget comfortable. */
const MOTN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Region MOTN falls back to when `WATCH_REGION` isn't in its 65 countries. */
const FALLBACK_COUNTRY = "us";

export type MotnOptionType =
  | "free"
  | "subscription"
  | "addon"
  | "rent"
  | "buy";

export type MotnOption = {
  serviceId: string;
  serviceName: string;
  /** White service mark — legible on the dark card. */
  logo: string | null;
  type: MotnOptionType;
  quality: string | null;
  link: string;
  price: string | null;
  /** Last day to watch, as unix seconds. Only set when genuinely expiring soon. */
  expiresOn: number | null;
  addon: string | null;
};

export type MotnWatch = {
  country: string;
  /** MOTN cross-source score 0–100 (TMDB's own score stays on the ScoreStrip). */
  rating: number | null;
  options: MotnOption[];
};

type MotnRawOption = {
  service?: {
    id?: string;
    name?: string;
    imageSet?: { whiteImage?: string; darkThemeImage?: string };
  };
  type?: string;
  quality?: string;
  link?: string;
  price?: { formatted?: string };
  expiresSoon?: boolean;
  expiresOn?: number;
  addon?: { name?: string };
};

type MotnShow = {
  rating?: number;
  streamingOptions?: Record<string, MotnRawOption[]>;
};

function apiKey(): string | null {
  const key = process.env.MOTN_API_KEY?.trim();
  return key ? key : null;
}

/** Region to ask for — MOTN does not serve every country we do. */
function region(): string {
  return (process.env.WATCH_REGION || "NG").toLowerCase();
}

/** Optimisation: only surface expiry dates that are actually in the future. */
const EXPIRY_HORIZON_S = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60;

function normalise(raw: MotnShow, country: string): MotnWatch {
  const list = raw.streamingOptions?.[country] ?? [];
  const rank: Record<string, number> = {
    free: 0,
    subscription: 1,
    addon: 2,
    rent: 3,
    buy: 4,
  };

  const options: MotnOption[] = [];
  for (const o of list) {
    const type = o.type;
    if (!o.link || !type || !(type in rank)) continue;
    const expiresOn =
      o.expiresSoon && typeof o.expiresOn === "number" && o.expiresOn < EXPIRY_HORIZON_S
        ? o.expiresOn
        : null;
    options.push({
      serviceId: o.service?.id ?? "",
      serviceName: o.service?.name ?? "",
      logo: o.service?.imageSet?.whiteImage ?? o.service?.imageSet?.darkThemeImage ?? null,
      type: type as MotnOptionType,
      quality: o.quality ?? null,
      link: o.link,
      price: o.price?.formatted ?? null,
      expiresOn,
      addon: o.addon?.name ?? null,
    });
  }

  options.sort((a, b) => rank[a.type] - rank[b.type]);

  return {
    country,
    rating: typeof raw.rating === "number" ? raw.rating : null,
    options: options.slice(0, 16),
  };
}

async function callMotn(
  tmdbId: number,
  country: string
): Promise<MotnWatch | null> {
  const key = apiKey();
  if (!key) return null;

  const url = new URL(`${MOTN_BASE_URL}/shows/tv/${tmdbId}`);
  url.searchParams.set("country", country);

  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": key },
    signal: AbortSignal.timeout(12_000),
  });

  // Unsupported region → retry once against a country MOTN does serve.
  if ((res.status === 400 || res.status === 404) && country !== FALLBACK_COUNTRY) {
    return callMotn(tmdbId, FALLBACK_COUNTRY);
  }
  if (!res.ok) return null;

  const raw = (await res.json()) as MotnShow;
  if (!raw || typeof raw !== "object") return null;
  return normalise(raw, country);
}

// ---------- DB cache (tmdbListCache: key / payload / fetchedAt) ----------

const inflight = new Map<string, Promise<MotnWatch | null>>();
const refreshing = new Set<string>();

function ageMs(fetchedAt: Date | string | null | undefined): number {
  if (!fetchedAt) return Number.POSITIVE_INFINITY;
  const t =
    fetchedAt instanceof Date
      ? fetchedAt.getTime()
      : Date.parse(String(fetchedAt));
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

async function writeCache(key: string, value: MotnWatch): Promise<void> {
  try {
    await withDbRetry(() =>
      db
        .insert(tmdbListCache)
        .values({ key, payload: value, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: tmdbListCache.key,
          set: { payload: value, fetchedAt: new Date() },
        })
    );
  } catch {
    /* cache is an optimisation — never fail the page over it */
  }
}

/**
 * Where-to-watch for a show, or `null` when MOTN has nothing for it.
 * Stale-while-revalidate: past the TTL the cached row still renders and a
 * background refresh swaps it in for the next visit.
 */
export async function getShowWatchOptions(
  tmdbId: number
): Promise<MotnWatch | null> {
  const country = region();
  const key = `motn:tv:${tmdbId}:${country}`;

  let cached: MotnWatch | null = null;
  let fetchedAt: Date | string | null = null;
  try {
    const row = await withDbRetry(() =>
      db.select().from(tmdbListCache).where(eq(tmdbListCache.key, key)).limit(1)
    );
    const payload = row[0]?.payload as MotnWatch | null | undefined;
    if (payload && Array.isArray(payload?.options)) {
      cached = payload;
      fetchedAt = row[0]?.fetchedAt ?? null;
    }
  } catch {
    /* DB down → treat as a miss and let the fetch decide */
  }

  const fresh = cached && ageMs(fetchedAt) <= MOTN_TTL_MS;

  if (fresh) return cached;

  if (cached) {
    // Stale-while-revalidate: serve now, refresh behind the user.
    if (!refreshing.has(key)) {
      refreshing.add(key);
      void callMotn(tmdbId, country)
        .then(async (freshData) => {
          if (freshData) await writeCache(key, freshData);
        })
        .catch(() => undefined)
        .finally(() => refreshing.delete(key));
    }
    return cached;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const data = await callMotn(tmdbId, country);
      if (data) await writeCache(key, data);
      return data;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}
