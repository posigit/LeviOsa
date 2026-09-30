/**
 * Resolve Vix / Goated master playlist URLs for native playback.
 *
 * Goated has TWO backends behind one API: Orbit first (media proven working
 * end-to-end through the proxy, 2026-08-09) then Valenox (fallback), then Vix
 * as the LAST native fallback before iframe, then vidsrc-sh as the final
 * resort (prod: vix blocked, vidsrc-sh may answer).
 *
 * Each attempt is time-bounded AND the whole cascade has an overall deadline
 * so a throttled resolver ("Loading…" forever) fails fast instead of hanging
 * the player for ~2 minutes.
 */

import type { StreamSource } from "@/lib/player-native-types";

export type StreamResolveResult = {
  playlistUrl: string | null;
  imdbId: string | null;
  /** Seek-preview thumbnails (VTT URL) — null when the source has none. */
  thumbnailsUrl?: string | null;
  /**
   * All signed vidsrc-sh mirrors (same title, alternate hosts). Downloads try
   * them in order — a dead first mirror no longer fails the whole title.
   */
  playlistUrls?: string[];
  failed: boolean;
  /** True when the caller aborted (effect cleanup) — not a failure. */
  aborted?: boolean;
  errorMessage?: string;
  /** Machine-readable failure code from the stream route (if any). */
  code?: string;
  /** Human-readable diagnosis from the stream route (if any). */
  detail?: string;
  /** False when the deployment has no VIX resolver configured. */
  resolverConfigured?: boolean;
  /** Which backend actually produced the playlist (diagnostics). */
  usedSource?: "valenox" | "orbit" | "vix" | "vidsrc-sh";
  /** True when the goated cascade exhausted and vix was tried as fallback. */
  fellBackToVix?: boolean;
  /** True when vidsrc-sh was tried as the final resort. */
  fellBackToVidsrcSh?: boolean;
  /** Per-attempt outcomes (diagnostics / console). */
  attempts?: Array<{ source: string; ok: boolean; error?: string }>;
};

/**
 * Goated backend order: Orbit first (media proven working end-to-end through
 * the proxy, 2026-08-09), Valenox fallback (resolves but its media worker
 * rejects our proxy's origins — 403 Origin not allowed). Valenox stays in
 * the chain in case its lock opens, but never blocks playback.
 */
const GOATED_ORDER = ["Orbit", "Valenox"] as const;

/**
 * 30s cap per attempt. The reallyfast resolver is documented to take 15-40s
 * (and up to 90s) when throttled; this matches the observed ceiling so a
 * slow-but-alive resolver still resolves, but a hung/blackhole request moves
 * on instead of freezing the player forever. The OVERALL deadline below caps
 * the worst case at ~75s instead of ~2min.
 */
const RESOLVE_TIMEOUT_MS = 30_000;
const OVERALL_DEADLINE_MS = 75_000;
const JSON_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(
  url: string,
  signal?: AbortSignal,
  timeoutMs: number = RESOLVE_TIMEOUT_MS
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return fetch(url, { signal: timeoutSignal });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const combined =
    typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any ===
    "function"
      ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([
          signal,
          timeoutSignal,
        ])
      : timeoutSignal;
  return fetch(url, { signal: combined });
}

/** Bound text read — same deadline as JSON so error bodies can't hang outside budget. */
async function readTextBounded(res: Response): Promise<string> {
  const body = (async () => res.text().catch(() => ""))();
  const timeout = new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve(""), JSON_TIMEOUT_MS);
    body.finally(() => clearTimeout(t));
  });
  return Promise.race([body, timeout]);
}

/** Bound res.json() — headers may resolve quickly while the body hangs. */
async function readJson<T>(res: Response): Promise<T> {
  const body = (async () => res.json() as Promise<T>)();
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("response body timeout")), JSON_TIMEOUT_MS);
    body.finally(() => clearTimeout(t));
  });
  return Promise.race([body, timeout]);
}

async function resolveOne(
  routeLabel: "vix" | "goated",
  params: URLSearchParams,
  signal?: AbortSignal,
  timeoutMs: number = RESOLVE_TIMEOUT_MS
): Promise<{
  playlistUrl: string | null;
  imdbId: string | null;
  thumbnailsUrl?: string | null;
  error?: string;
  code?: string;
  detail?: string;
  resolverConfigured?: boolean;
}> {
  try {
    const res = await fetchWithTimeout(
      `/api/${routeLabel === "vix" ? "vixsrc" : "goated"}/stream?${params.toString()}`,
      signal,
      timeoutMs
    );
    if (!res.ok) {
      let code: string | undefined;
      let detail: string | undefined;
      let resolverConfigured: boolean | undefined;
      let text = "";
      try {
        const data = (await readJson(res)) as {
          error?: string;
          code?: string;
          detail?: string;
          resolverConfigured?: boolean;
        };
        text = data?.error ?? "";
        code = data?.code;
        detail = data?.detail;
        resolverConfigured = data?.resolverConfigured;
      } catch {
        text = await readTextBounded(res);
      }
      return {
        playlistUrl: null,
        imdbId: null,
        thumbnailsUrl: null,
        error: `stream route ${res.status}: ${text.slice(0, 200)}`,
        code,
        detail,
        resolverConfigured,
      };
    }
    const data = (await readJson(res)) as {
      url?: string;
      playlistUrl?: string;
      imdbId?: string | null;
      thumbnailsUrl?: string | null;
    };
    const imdbId = data?.imdbId ?? null;
    const thumbnailsUrl =
      typeof data?.thumbnailsUrl === "string" ? data.thumbnailsUrl : null;
    if (data?.playlistUrl)
      return { playlistUrl: data.playlistUrl, imdbId, thumbnailsUrl };
    if (data?.url) {
      // Goated resolve returns a raw backend URL; route it through the media
      // proxy. Backend provides no thumbnails here — explicit null keeps the
      // shape consistent with the vix/vidsrc-sh branches.
      return {
        playlistUrl: `/api/goated/media?url=${encodeURIComponent(data.url)}`,
        imdbId,
        thumbnailsUrl: null,
      };
    }
    return { playlistUrl: null, imdbId, thumbnailsUrl: null, error: "no playlist in response" };
  } catch (err) {
    // Aborted by the caller (effect cleanup) = not a failure, never report it.
    if (signal?.aborted) return { playlistUrl: null, imdbId: null, thumbnailsUrl: null };
    return {
      playlistUrl: null,
      imdbId: null,
      thumbnailsUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Single shared vidsrc-sh last-resort fetch (was duplicated 30+ lines twice). */
async function resolveVidsrcSh(
  base: URLSearchParams,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  record: (source: string, r: { playlistUrl: string | null; error?: string }) => void
): Promise<{
  playlistUrl: string | null;
  imdbId: string | null;
  thumbnailsUrl: string | null;
  playlistUrls: string[];
  error?: string;
}> {
  const empty = { playlistUrl: null, imdbId: null, thumbnailsUrl: null, playlistUrls: [] as string[] };
  try {
    const res = await fetchWithTimeout(`/api/vidsrc-sh/stream?${base.toString()}`, signal, timeoutMs);
    if (res.ok) {
      const data = (await readJson(res)) as {
        playlistUrl?: string;
        playlistUrls?: string[];
        imdbId?: string | null;
        thumbnailsUrl?: string | null;
      };
      if (data?.playlistUrl) {
        const mirrors = Array.isArray(data.playlistUrls)
          ? data.playlistUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
          : [];
        // Primary first, then the rest (deduped) — downloads walk them all.
        const playlistUrls = [data.playlistUrl, ...mirrors.filter((u) => u !== data.playlistUrl)];
        const out = {
          playlistUrl: data.playlistUrl,
          imdbId: data.imdbId ?? null,
          thumbnailsUrl: data.thumbnailsUrl ?? null,
          playlistUrls,
        };
        record("vidsrc-sh", out);
        return out;
      }
    }
    const err = `route ${res.status}`;
    record("vidsrc-sh", { playlistUrl: null, error: err });
    return { ...empty, error: err };
  } catch (err) {
    if (err instanceof Error && signal?.aborted) {
      return empty;
    }
    const msg = err instanceof Error ? err.message : String(err);
    record("vidsrc-sh", { playlistUrl: null, error: msg });
    return { ...empty, error: msg };
  }
}

function abortedResult(imdbId: string | null, attempts: StreamResolveResult["attempts"]): StreamResolveResult {
  return { playlistUrl: null, imdbId, thumbnailsUrl: null, failed: false, aborted: true, attempts };
}

export async function resolveStreamPlaylist(opts: {
  source: StreamSource;
  type: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  signal?: AbortSignal;
}): Promise<StreamResolveResult> {
  if (!Number.isSafeInteger(opts.tmdbId) || opts.tmdbId <= 0) {
    return {
      playlistUrl: null,
      imdbId: null,
      thumbnailsUrl: null,
      failed: true,
      errorMessage: "invalid tmdbId",
      attempts: [],
    };
  }
  const base = new URLSearchParams({
    type: opts.type,
    id: String(opts.tmdbId),
  });
  if (opts.season != null) base.set("season", String(opts.season));
  if (opts.episode != null) base.set("episode", String(opts.episode));

  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  const budget = () => Math.max(1_000, Math.min(RESOLVE_TIMEOUT_MS, deadline - Date.now()));
  const expired = () => Date.now() >= deadline || opts.signal?.aborted === true;

  const attempts: StreamResolveResult["attempts"] = [];
  const record = (
    source: string,
    r: { playlistUrl: string | null; error?: string }
  ) => attempts!.push({ source, ok: !!r.playlistUrl, error: r.error });

  // Vix: single attempt — unchanged behavior, plus the vidsrc-sh last
  // resort on failure (prod: vix blocked, vidsrc-sh may answer).
  if (opts.source === "vix") {
    const r = await resolveOne("vix", base, opts.signal, budget());
    record("vix", r);
    if (r.playlistUrl) {
      return {
        playlistUrl: r.playlistUrl,
        imdbId: r.imdbId,
        thumbnailsUrl: r.thumbnailsUrl ?? null,
        failed: false,
        usedSource: "vix",
        attempts,
      };
    }
    if (opts.signal?.aborted) return abortedResult(r.imdbId, attempts);
    if (!expired()) {
      const s = await resolveVidsrcSh(base, opts.signal, budget(), record);
      if (s.playlistUrl) {
        return {
          playlistUrl: s.playlistUrl,
          imdbId: s.imdbId ?? r.imdbId,
          thumbnailsUrl: s.thumbnailsUrl ?? null,
          playlistUrls: s.playlistUrls,
          failed: false,
          usedSource: "vidsrc-sh",
          fellBackToVidsrcSh: true,
          attempts,
        };
      }
    }
    return {
      playlistUrl: null,
      imdbId: r.imdbId,
      thumbnailsUrl: null,
      failed: true,
      errorMessage: [...attempts].reverse().find((a) => !a.ok)?.error ?? r.error,
      code: r.code,
      detail: r.detail,
      resolverConfigured: r.resolverConfigured,
      usedSource: undefined,
      fellBackToVix: false,
      fellBackToVidsrcSh: attempts.some((a) => a.source === "vidsrc-sh"),
      attempts,
    };
  }

  // Explicit VidSrc.sh selection: try it first, then fall through to the
  // goated → vix cascade. vidsrcTried stops the end-of-cascade last resort
  // from re-running the request that just failed.
  let vidsrcTried = false;
  if (opts.source === "vidsrc-sh") {
    vidsrcTried = true;
    const s = await resolveVidsrcSh(base, opts.signal, budget(), record);
    if (s.playlistUrl) {
      return {
        playlistUrl: s.playlistUrl,
        imdbId: s.imdbId,
        thumbnailsUrl: s.thumbnailsUrl,
        playlistUrls: s.playlistUrls,
        failed: false,
        usedSource: "vidsrc-sh",
        attempts,
      };
    }
    if (opts.signal?.aborted) return abortedResult(s.imdbId, attempts);
  }

  // First structured diagnosis seen across attempts (surfaced on failure).
  const diag: {
    code?: string;
    detail?: string;
    resolverConfigured?: boolean;
  } = {};
  const noteDiag = (r: {
    code?: string;
    detail?: string;
    resolverConfigured?: boolean;
  }) => {
    if (diag.code == null && r.code != null) {
      diag.code = r.code;
      diag.detail = r.detail;
      diag.resolverConfigured = r.resolverConfigured;
    }
  };

  // Goated cascade: Orbit → Valenox → Vix (last native fallback).
  let imdbId: string | null = null;
  for (const backend of GOATED_ORDER) {
    if (opts.signal?.aborted) return abortedResult(imdbId, attempts);
    if (expired()) break;
    const p = new URLSearchParams(base);
    p.set("source", backend);
    const r = await resolveOne("goated", p, opts.signal, budget());
    record(`goated:${backend}`, r);
    noteDiag(r);
    if (r.imdbId) imdbId = r.imdbId;
    if (r.playlistUrl) {
      return {
        playlistUrl: r.playlistUrl,
        imdbId,
        thumbnailsUrl: r.thumbnailsUrl ?? null,
        failed: false,
        usedSource: backend.toLowerCase() as "valenox" | "orbit",
        attempts,
      };
    }
  }

  // Last native fallback — vix before giving up to iframe.
  if (opts.signal?.aborted) return abortedResult(imdbId, attempts);
  if (!expired()) {
    const v = await resolveOne("vix", base, opts.signal, budget());
    record("vix", v);
    noteDiag(v);
    if (v.playlistUrl) {
      return {
        playlistUrl: v.playlistUrl,
        imdbId: v.imdbId ?? imdbId,
        thumbnailsUrl: v.thumbnailsUrl ?? null,
        failed: false,
        usedSource: "vix",
        fellBackToVix: true,
        attempts,
      };
    }
    imdbId = v.imdbId ?? imdbId;
  }
  // Last resort native: data.vidsrc.sh (WASM-decrypted direct HLS, tokenized
  // + proxied through /api/vidsrc-sh/media). Runs only when vix + goated
  // both failed, so it never slows the working paths — and in prod it may be
  // the ONLY reachable native backend.
  if (!vidsrcTried && !opts.signal?.aborted && !expired()) {
    vidsrcTried = true;
    const s = await resolveVidsrcSh(base, opts.signal, budget(), record);
    if (s.playlistUrl) {
      return {
        playlistUrl: s.playlistUrl,
        imdbId: s.imdbId ?? imdbId,
        thumbnailsUrl: s.thumbnailsUrl ?? null,
        playlistUrls: s.playlistUrls,
        failed: false,
        usedSource: "vidsrc-sh",
        fellBackToVix: attempts.some((a) => a.source === "vix"),
        fellBackToVidsrcSh: true,
        attempts,
      };
    }
  }
  if (opts.signal?.aborted) return abortedResult(imdbId, attempts);
  const lastErr = [...attempts].reverse().find((a) => !a.ok)?.error;
  return {
    playlistUrl: null,
    imdbId,
    thumbnailsUrl: null,
    failed: true,
    errorMessage: lastErr ?? "all sources failed",
    code: diag.code,
    detail: diag.detail,
    resolverConfigured: diag.resolverConfigured,
    fellBackToVix: attempts.some((a) => a.source === "vix"),
    fellBackToVidsrcSh: vidsrcTried,
    attempts,
  };
}
