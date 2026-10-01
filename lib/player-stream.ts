/**
 * Resolve a native master playlist URL for the PICKED source only.
 *
 * No cross-source fallback: the picked source either answers or the failure
 * (with its REAL route status — 404 / 403 / 429 / 5xx) is returned so the
 * error card can say e.g. "vidsrc-pm ✗ 404" and the source can be removed.
 * The player's "Try <source>" button is the manual escape hatch.
 *
 * Goated keeps its two backends (Orbit first — media proven working
 * end-to-end through the proxy, 2026-08-09 — then Valenox) as its internal
 * order: both are servers OF the goated source, not other sources.
 *
 * Each attempt is time-bounded AND a deadline caps the whole resolve so a
 * throttled resolver ("Loading…" forever) fails fast instead of hanging
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
  usedSource?: "valenox" | "orbit" | "vix" | "vidsrc-sh" | "vidsrc-pm";
  /** Per-attempt outcomes — surfaced on failure so the error card can name
   *  the failing source with its real HTTP status (e.g. "vidsrc-pm ✗ 404"). */
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

/** Shared native fetch for vidsrc-sh / vidsrc-pm stream routes. On failure it
 *  keeps the route's structured body (code/detail) and the real HTTP status
 *  so the error card can name the source + status. */
async function resolveNativeRoute(
  route: "vidsrc-sh" | "vidsrc-pm",
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
  code?: string;
  detail?: string;
}> {
  const empty = { playlistUrl: null, imdbId: null, thumbnailsUrl: null, playlistUrls: [] as string[] };
  try {
    const res = await fetchWithTimeout(`/api/${route}/stream?${base.toString()}`, signal, timeoutMs);
    type Body = {
      playlistUrl?: string;
      playlistUrls?: string[];
      imdbId?: string | null;
      thumbnailsUrl?: string | null;
      error?: string;
      code?: string;
      detail?: string;
    };
    let data: Body | null = null;
    try {
      data = await readJson<Body>(res);
    } catch {
      /* non-JSON / hanging body — status still carries the verdict */
    }
    if (res.ok && data?.playlistUrl) {
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
      record(route, out);
      return out;
    }
    const text = data?.error ?? (res.ok ? "no playlist in response" : "");
    const err = res.ok ? text : `route ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
    record(route, { playlistUrl: null, error: err });
    return { ...empty, error: err, code: data?.code, detail: data?.detail };
  } catch (err) {
    if (err instanceof Error && signal?.aborted) {
      return empty;
    }
    const msg = err instanceof Error ? err.message : String(err);
    record(route, { playlistUrl: null, error: msg });
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

  const attempts: StreamResolveResult["attempts"] = [];
  const record = (
    source: string,
    r: { playlistUrl: string | null; error?: string }
  ) => attempts!.push({ source, ok: !!r.playlistUrl, error: r.error });

  // Structured diagnosis from the picked source's route (surfaced on failure).
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

  const fail = (imdbId: string | null, errorMessage?: string): StreamResolveResult => {
    const lastErr = [...attempts].reverse().find((a) => !a.ok)?.error;
    return {
      playlistUrl: null,
      imdbId,
      thumbnailsUrl: null,
      failed: true,
      errorMessage: errorMessage ?? lastErr ?? "source failed",
      code: diag.code,
      detail: diag.detail,
      resolverConfigured: diag.resolverConfigured,
      attempts,
    };
  };

  // Picked source = vix: single attempt — its real status on failure.
  if (opts.source === "vix") {
    const r = await resolveOne("vix", base, opts.signal, budget());
    record("vix", r);
    noteDiag(r);
    if (opts.signal?.aborted) return abortedResult(r.imdbId, attempts);
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
    return fail(r.imdbId, r.error);
  }

  // Picked source = vidsrc-pm / vidsrc-sh: single attempt, real status kept.
  if (opts.source === "vidsrc-pm" || opts.source === "vidsrc-sh") {
    const r = await resolveNativeRoute(opts.source, base, opts.signal, budget(), record);
    if (opts.signal?.aborted) return abortedResult(r.imdbId, attempts);
    noteDiag(r);
    if (r.playlistUrl) {
      return {
        playlistUrl: r.playlistUrl,
        imdbId: r.imdbId,
        thumbnailsUrl: r.thumbnailsUrl ?? null,
        playlistUrls: r.playlistUrls,
        failed: false,
        usedSource: opts.source,
        attempts,
      };
    }
    return fail(r.imdbId, r.error);
  }

  // Picked source = goated: its two backends (Orbit → Valenox) in order —
  // both are servers OF goated, not other sources.
  if (opts.source === "goated") {
    let imdbId: string | null = null;
    for (const backend of GOATED_ORDER) {
      if (opts.signal?.aborted) return abortedResult(imdbId, attempts);
      if (Date.now() >= deadline) return fail(imdbId, "resolve deadline exceeded");
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
    return fail(imdbId);
  }

  // Embed/other sources have no native resolver — the player guards with
  // iframe mode before resolving, but fail loud if ever asked.
  return fail(null, `source "${opts.source}" has no native resolver`);
}
