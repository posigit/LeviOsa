/**
 * vidsrc.pm (Vidora) stream resolver + media-proxy signing (server-side).
 *
 * The embed player calls GET /api/vidora/v1/{movie|tv}/...?source=scrapify
 * with a static x-player-key header baked into its bundle, then plays the
 * returned p1.netocdn.site proxy playlist whose bare /segment refs are
 * Referer-gated on https://vidsrc.pm/. Both legs run here so the app plays
 * vidsrc.pm natively (no iframe): /api/vidsrc-pm/stream returns a signed
 * /api/vidsrc-pm/media URL, and the media route re-hosts playlist + segments
 * on the app origin (CORS on netocdn only allows https://vidsrc.pm).
 */

import {
  SHARED_UA,
  fetchWithTimeout,
  type MediaParams,
} from "@/lib/stream-proxy";

const VIDSRC_PM_API = "https://vidsrc.pm/api/vidora/v1";

/** Static x-player-key from the vidsrc.pm embed bundle (assets/main-*.js). */
const VIDSRC_PM_PLAYER_KEY =
  "f3b72e73c80c9a996574379798703796a1936efa3516a7105cb0e43048b46b5a";

/** Referer both legs require: the API 401s without its embed page, media 403s. */
export const VIDSRC_PM_REFERER = "https://vidsrc.pm/";

const RESOLVE_TIMEOUT_MS = 15_000;

/**
 * The vidsrc.pm API intermittently 502s / times out between healthy answers
 * (observed 2026-10-01: same URL fails then succeeds seconds later). One quick
 * retry covers that blip so the player doesn't waste a cascade falling back
 * to a weaker source. 4xx is NOT retried — a rotated player key etc. needs
 * a code change, not another identical request.
 */
const RESOLVE_RETRIES = 1;
const RETRY_BACKOFF_MS = 500;

export type VidsrcPmResolveResult = {
  playlistUrl: string;
  title: string | null;
  imdbId: string | null;
};

/** Only the netocdn proxy host family — whatever the API returns must be ours. */
export function vidsrcPmAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "p1.netocdn.site" || h.endsWith(".netocdn.site");
}

export async function vidsrcPmResolve(
  params: MediaParams
): Promise<VidsrcPmResolveResult> {
  const path =
    params.type === "movie"
      ? `movie/${params.id}`
      : `tv/${params.id}/${params.season}/${params.episode}`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RESOLVE_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${VIDSRC_PM_API}/${path}?source=scrapify`,
        {
          headers: {
            "User-Agent": SHARED_UA,
            Accept: "application/json, text/plain, */*",
            Referer: `https://vidsrc.pm/embed/${path}`,
            "x-player-key": VIDSRC_PM_PLAYER_KEY,
          },
          cache: "no-store",
        },
        RESOLVE_TIMEOUT_MS
      );
    } catch (err) {
      // Network error / timeout — the flake class retry exists for.
      lastErr = err instanceof Error ? new Error(`vidsrc.pm: ${err.message}`) : new Error("vidsrc.pm: fetch failed");
      continue;
    }
    if (!res.ok) {
      const err = new Error(`vidsrc.pm api ${res.status}`);
      if (res.status >= 500 || res.status === 429) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    const data = (await res.json().catch(() => null)) as {
      result?: boolean;
      title?: string;
      imdb_id?: string;
      sources?: Array<{ url?: string }>;
    } | null;
    if (!data?.result) {
      // 200 with no payload = upstream blip (seen under load) — retryable.
      lastErr = new Error("vidsrc.pm returned no result");
      continue;
    }
    const url = data.sources?.find(
      (s) => typeof s.url === "string" && s.url.length > 0
    )?.url;
    if (!url) throw new Error("vidsrc.pm returned no sources");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("vidsrc.pm returned an invalid url");
    }
    if (parsed.protocol !== "https:" || !vidsrcPmAllowedHost(parsed.hostname)) {
      throw new Error("vidsrc.pm returned a blocked host");
    }
    return {
      playlistUrl: parsed.toString(),
      title: data.title ?? null,
      imdbId: data.imdb_id ?? null,
    };
  }
  throw lastErr ?? new Error("vidsrc.pm failed");
}

// ---------- proxy URL signing (abuse guard, WebCrypto — Node + Workers) ----------
// Same pattern as lib/vidsrc-sh.ts: /api/vidsrc-pm/media would otherwise be
// an open https fetch proxy. Every URL we mint is signed with AUTH_SECRET
// under a vidsrc-pm context (cross-source replay impossible) and expires —
// TTL is 12h, long enough that segment URLs signed when the playlist loaded
// stay valid for the whole movie (playlists are not re-fetched for VOD).

let warnedNoSecret = false;

function proxySecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("[vidsrc-pm] AUTH_SECRET missing/short in production — refusing to sign");
  }
  if (!warnedNoSecret) {
    warnedNoSecret = true;
    console.warn(
      "[vidsrc-pm] AUTH_SECRET missing/short — proxy URLs signed with an insecure dev fallback (non-production only)"
    );
  }
  return "dev-only-insecure-proxy-key";
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "binary").toString("base64")
      : btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacHex(target: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(proxySecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${exp}.vidsrc-pm.${target}`)
  );
  return b64url(new Uint8Array(sig));
}

/** Build an expiring signed /api/vidsrc-pm/media URL for a target. */
export async function signVidsrcPmProxyUrl(target: string, ttlSec = 43_200): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(target, exp);
  return `/api/vidsrc-pm/media?url=${encodeURIComponent(target)}&exp=${exp}&sig=${sig}`;
}

/** True when sig matches target and exp is fresh (constant-time compare). */
export async function verifyVidsrcPmProxyUrl(
  target: string,
  sig: string | null,
  expRaw: string | null
): Promise<boolean> {
  if (!sig || !expRaw) return false;
  if (!/^\d+$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp < now - 60 || exp > now + 7 * 24 * 3600) {
    return false;
  }
  const expected = await hmacHex(target, exp);
  if (expected.length !== sig.length) return false;
  // Constant-time compare (no early exit on first mismatch).
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}
