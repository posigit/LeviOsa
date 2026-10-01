import { NextRequest, NextResponse } from "next/server";
import { VIX_LANG } from "@/lib/vixsrc";
import { getResolverBases } from "@/lib/resolver-env";
import { fetchWithTimeout, parseMediaParams, SHARED_UA } from "@/lib/stream-proxy";

/**
 * VixSrc native stream resolver.
 *
 * vixsrc.to guards its HTML pages with Cloudflare bot protection (challenge in
 * cross-site iframes, blocks *.vercel.app referers), but its JSON/API and HLS
 * endpoints are open and CORS-permissive. Most of the app's hosts are
 * Cloudflare-blocked (Vercel returns 403, public proxies return 403/52x), so
 * on production the resolution happens on a small standalone service
 * (resolver-server/) deployed on a network vixsrc accepts — pass its base URL
 * as VIX_RESOLVER_URL. When unset, this route resolves directly (e.g.
 * localhost).
 *
 * Both paths hand back a playable master playlist URL:
 *
 *   /api/movie|tv/{id}  ->  signed embed src  ->  embed page masterPlaylist  ->  m3u8
 *
 * The client then plays the m3u8 natively (hls.js) — no iframe, no CF challenge,
 * no third-party cookies, works from any origin.
 */
export const dynamic = "force-dynamic";

const UA = SHARED_UA;

async function fetchImdbId(type: string, id: number): Promise<string | null> {
  if (!process.env.TMDB_API_KEY) return null;
  const extPath =
    type === "tv" ? `/tv/${id}/external_ids` : `/movie/${id}/external_ids`;
  try {
    const extRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3${extPath}?api_key=${process.env.TMDB_API_KEY}`,
      { cache: "no-store" },
      8_000
    );
    if (extRes.ok) {
      const ct = extRes.headers.get("content-type") ?? "";
      if (!ct.includes("json")) return null;
      const ext = (await extRes.json()) as { imdb_id?: string | null };
      if (ext.imdb_id) return ext.imdb_id;
    }
  } catch {
    /* imdbId is optional — skip on failure */
  }
  return null;
}

export async function GET(req: NextRequest) {
  let params: ReturnType<typeof parseMediaParams>;
  try {
    params = parseMediaParams(req.nextUrl.searchParams);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bad request" },
      { status: 400 }
    );
  }
  const { type, id, season, episode } = params;

  // Validated base URLs only — a placeholder/garbage value must fail loud
  // (resolver_misconfigured) instead of attempting a doomed fetch.
  // Multiple resolvers fail over in order: first 2xx wins, so one burned
  // host never takes down native playback while others are healthy.
  const resolvers = getResolverBases();
  const resolverRaw = [process.env.VIX_RESOLVER_URLS, process.env.VIX_RESOLVER_URL]
    .filter(Boolean)
    .join(",")
    .trim();
  const resolverStages: string[] = [];
  if (resolverRaw && resolvers.length === 0) {
    resolverStages.push(
      "VIX_RESOLVER_URL(S) is set but holds no valid http(s) base URL — check for a redaction placeholder or a pasted path/tunnel URL"
    );
  }

  // Deployed path: resolve from a non-blocked service, then enrich with IMDb.
  // Aggregate deadline: 2 hosts x 8s max — never exceed the client's window.
  const deadline = Date.now() + 18_000;
  const rp = new URLSearchParams({ type, id: String(id) });
  if (season != null) rp.set("season", String(season));
  if (episode != null) rp.set("episode", String(episode));
  for (const resolver of resolvers) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;
    try {
      // Cold starts can be slow — per-host budget stays tight so one dead
      // host can't eat the whole client window before failover/direct.
      const res = await fetchWithTimeout(
        `${resolver}/stream?${rp.toString()}`,
        { cache: "no-store" },
        Math.min(8_000, remaining)
      );
      if (res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("json")) {
          resolverStages.push(`${new URL(resolver).hostname}: non-JSON resolver reply`);
          continue;
        }
        const data = (await res.json()) as { playlistUrl?: unknown } & Record<string, unknown>;
        // The resolver hands back a RELATIVE /media?url=... (it proxies the
        // playlist + segments through itself). Prefix the resolver base so
        // hls.js fetches the whole chain from the resolver, which vixsrc
        // accepts — the browser could never fetch vixsrc.to directly (403).
        let playlistUrl = data.playlistUrl;
        if (typeof playlistUrl === "string" && playlistUrl.startsWith("/media")) {
          playlistUrl = `${resolver}${playlistUrl}`;
        }
        if (typeof playlistUrl === "string" && playlistUrl.startsWith("https://")) {
          return NextResponse.json({
            ...data,
            playlistUrl,
            resolverHost: new URL(resolver).hostname,
            imdbId: await fetchImdbId(type, id),
          });
        }
        resolverStages.push(`${new URL(resolver).hostname}: invalid playlistUrl`);
        continue;
      }
      // Capture a snippet of the resolver's error body — the host's own
      // "Application not found" vs the resolver's JSON tells you whether the
      // SERVICE is dead vs the source blocking it.
      let bodyHint = "";
      try {
        bodyHint = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
      } catch {
        /* ignore */
      }
      resolverStages.push(`${new URL(resolver).hostname}: ${res.status}${bodyHint ? ` — ${bodyHint}` : ""}`);
      // Non-2xx from this resolver: try the next one.
    } catch (err) {
      resolverStages.push(`${new URL(resolver).hostname}: ${err instanceof Error ? err.message.slice(0, 160) : "resolver failed"}`);
      // Resolver unreachable/error: try the next one.
    }
  }
  const stages: { resolver?: string; direct?: string } = {};
  if (resolverStages.length > 0) stages.resolver = resolverStages.join(" | ");

  const mediaPath =
    type === "tv" ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
  const referer = `https://vixsrc.to/${mediaPath}`;

  try {
    // 1. API route -> signed embed src (no CF challenge on JSON endpoints)
    const apiRes = await fetchWithTimeout(
      `https://vixsrc.to/api/${mediaPath}`,
      {
        headers: { "User-Agent": UA, Referer: referer, Accept: "application/json" },
        cache: "no-store",
      },
      10_000
    );
    if (!apiRes.ok) throw new Error(`vixsrc api ${apiRes.status}`);
    const apiCt = apiRes.headers.get("content-type") ?? "";
    if (!apiCt.includes("json")) throw new Error("vixsrc api returned non-JSON");
    const apiJson = (await apiRes.json()) as { src?: string };
    if (!apiJson.src || !apiJson.src.startsWith("/")) throw new Error("vixsrc api returned no src");

    // 2. Embed page -> master playlist url + signed params
    const embedRes = await fetchWithTimeout(
      `https://vixsrc.to${apiJson.src}`,
      {
        headers: { "User-Agent": UA, Referer: referer },
        cache: "no-store",
      },
      10_000
    );
    if (!embedRes.ok) throw new Error(`vixsrc embed ${embedRes.status}`);
    const html = await embedRes.text();

    const urlMatch = html.match(
      /window\.masterPlaylist\s*=\s*\{[\s\S]*?url:\s*'([^']+)'/
    );
    if (!urlMatch) throw new Error("no master playlist in embed page");

    const grab = (key: string) =>
      html.match(new RegExp(`'${key}':\\s*'([^']*)'`))?.[1] ?? "";
    const thumbMatch = html.match(/window\.thumbnailsUrl\s*=\s*'([^']+)'/);

    const params = new URLSearchParams();
    const token = grab("token");
    const expires = grab("expires");
    const asn = grab("asn");
    if (token) params.set("token", token);
    if (expires) params.set("expires", expires);
    if (asn) params.set("asn", asn);
    // The embed player appends these exactly like this (see vixsrc embed JS):
    params.set("h", "1");
    params.set("lang", VIX_LANG);

    // masterPlaylist.url may already carry a query (e.g. ?b=1) — append via
    // URLSearchParams so the existing query survives. Resolve relative
    // masters against the vixsrc origin (never crash on /playlist/...).
    const playlist = new URL(urlMatch[1], "https://vixsrc.to");
    if (playlist.protocol !== "https:") throw new Error("invalid master playlist url");
    for (const [k, v] of params) playlist.searchParams.set(k, v);

    return NextResponse.json({
      playlistUrl: playlist.toString(),
      thumbnailsUrl: thumbMatch?.[1] ?? null,
      imdbId: await fetchImdbId(type, id),
      season: type === "tv" ? season : null,
      episode: type === "tv" ? episode : null,
    });
  } catch (err) {
    const directErr = err instanceof Error ? err.message : "vixsrc stream failed";
    stages.direct = directErr;
    // Machine-readable codes so clients can tell "no stream exists" apart
    // from "this deployment can't reach the source". Direct Vercel → vixsrc
    // requests are Cloudflare-blocked (403); production depends on the
    // standalone resolver (VIX_RESOLVER_URL / VIX_RESOLVER_URLS).
    const code = !resolverRaw
      ? "resolver_unconfigured"
      : resolvers.length === 0
        ? "resolver_misconfigured"
        : "resolution_failed";
    // Real upstream status when the source itself answered badly ("vixsrc
    // api 404") — misconfiguration codes stay 502 (our problem, not vix's).
    const statusMatch = /\b([45]\d{2})\b/.exec(directErr);
    const upstream = statusMatch ? Number(statusMatch[1]) : null;
    const status =
      code === "resolution_failed" && upstream && upstream >= 400 && upstream <= 599
        ? upstream
        : 502;
    return NextResponse.json(
      {
        error: directErr,
        code: status === 404 && code === "resolution_failed" ? "not_found" : code,
        detail: !resolverRaw
          ? "VIX_RESOLVER_URL is not set on this deployment and vixsrc blocks direct requests from it. Streaming still works via embeds, but native playback and downloads need the resolver."
          : resolvers.length === 0
            ? "VIX_RESOLVER_URL(S) is set but holds no valid http(s) base URL (placeholder or malformed). Paste the resolver service's public root URL with no trailing slash or path, then redeploy."
            : status === 404
              ? "vixsrc has no stream for this title/episode."
              : `Resolver and direct paths both failed (resolver: ${stages.resolver ?? "n/a"}; direct: ${directErr}). The resolver service may be down or blocked.`,
        resolverConfigured: resolvers.length > 0,
        resolverCount: resolvers.length,
        stages,
      },
      { status }
    );
  }
}