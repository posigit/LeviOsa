/**
 * Cloudflare Workers port of server.js — identical contract:
 *
 *   GET /stream?type=tv|movie&id=<tmdbId>[&season=N&episode=N]
 *   GET /media?url=<enc(playlist|segment|init url)>  — byte proxy
 *   GET /health
 *
 * Deploy (needs a free Cloudflare account, ~2 minutes):
 *   1. cd resolver-server && npx wrangler login && npx wrangler deploy
 *   2. Copy the *.workers.dev URL (root, no path) into the Vercel project's
 *      VIX_RESOLVER_URL and redeploy the frontend.
 *   3. Verify: <url>/health -> {"ok":true,...}
 *              <url>/stream?type=movie&id=27205 -> {"ok":true,"playlistUrl":"/media?..."}
 *
 * Only web-standard APIs are used (no node:http, no Buffer), so this file
 * doubles as its own test subject — see scripts/resolver-worker.test.mjs.
 * Mirrors lib/stream-proxy.ts — keep regexes/host rules in sync.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const UPSTREAM_TIMEOUT_MS = 10_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// vixsrc playlist/segment hosts we are willing to proxy. Anything else 403s
// (never an open redirect). Segments live on vix-content.net subdomains
// (e.g. sc-u6-01.vix-content.net), so match the suffix, not just the apex.
const PROXY_HOSTS = new Set(["vixsrc.to", "www.vixsrc.to"]);

function isProxyableHost(hostname) {
  if (typeof hostname !== "string") return false;
  const h = hostname.toLowerCase();
  return (
    PROXY_HOSTS.has(h) ||
    h === "vix-content.net" ||
    h.endsWith(".vix-content.net")
  );
}

function isPlaylistContentType(ct) {
  if (!ct || ct === "") return true;
  return (
    ct.includes("mpegurl") ||
    ct.includes("x-mpegurl") ||
    ct.includes("text") ||
    ct.includes("octet-stream")
  );
}

function parsePositiveInt(raw, name) {
  if (raw == null || raw === "") return undefined;
  if (!/^\d+$/.test(String(raw).trim())) {
    const e = new Error(`invalid ${name}`);
    e.status = 400;
    throw e;
  }
  const n = Number(String(raw).trim());
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000) {
    const e = new Error(`invalid ${name}`);
    e.status = 400;
    throw e;
  }
  return n;
}

function parseMediaParams(sp) {
  const type = sp.get("type");
  const idRaw = sp.get("id");
  if ((type !== "movie" && type !== "tv") || !idRaw) {
    const e = new Error("type (movie|tv) and id are required");
    e.status = 400;
    throw e;
  }
  const id = parsePositiveInt(idRaw, "id");
  if (id == null || id <= 0) {
    const e = new Error("invalid id");
    e.status = 400;
    throw e;
  }
  const season = parsePositiveInt(sp.get("season"), "season");
  const episode = parsePositiveInt(sp.get("episode"), "episode");
  if (type === "tv" && (season == null || episode == null)) {
    const e = new Error("season and episode are required for tv");
    e.status = 400;
    throw e;
  }
  if (type === "movie" && (season != null || episode != null)) {
    const e = new Error("season/episode are only valid for tv");
    e.status = 400;
    throw e;
  }
  return { type, id, season, episode };
}

function parseRetryAfterSeconds(header) {
  if (!header) return null;
  const h = String(header).trim();
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    return Number.isSafeInteger(n) && n >= 0 && n <= 3600 ? n : null;
  }
  const t = Date.parse(h);
  if (!Number.isNaN(t)) {
    const diff = Math.round((t - Date.now()) / 1000);
    if (diff >= 0 && diff <= 3600) return diff;
  }
  return null;
}
async function fetchWithTimeout(url, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const outer = init.signal || null;
  if (!outer) return fetch(url, { ...init, signal: timeoutSignal });
  if (outer.aborted) throw new DOMException("Aborted", "AbortError");
  if (typeof AbortSignal.any === "function") {
    return fetch(url, { ...init, signal: AbortSignal.any([outer, timeoutSignal]) });
  }
  return fetch(url, { ...init, signal: timeoutSignal });
}

/**
 * Rewrite every playlist reference through /media, resolved against the TRUE
 * target — not our own proxy URL. Covers:
 *  1. absolute https URLs (port-aware),
 *  2. quoted URI attrs incl. relative + protocol-relative,
 *  3. bare relative lines (variant/segment/key names).
 */
function rewriteBody(body, base) {
  const proxied = (ref) => {
    try {
      const abs = ref.startsWith("//") ? `${base.protocol}${ref}` : new URL(ref, base).toString();
      const u = new URL(unwrapVixMediaUrl(abs));
      if (u.protocol !== "https:" || !isProxyableHost(u.hostname)) return null;
      return `/media?url=${encodeURIComponent(u.toString())}`;
    } catch {
      return null;
    }
  };
  // 2. Quoted URI attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA ...).
  let out = body.replace(/(URI=")([^"]*)(")/g, (full, pre, ref, post) => {
    if (!ref || ref.startsWith("data:")) return full;
    const p = proxied(ref);
    return p ? `${pre}${p}${post}` : full;
  });
  // 1. Absolute URLs anywhere (port-aware).
  out = out.replace(/https?:\/\/[a-z0-9.-]+(?::\d+)?(\/[^\s"'<>]*)/gi, (full) => {
    try {
      const unwrapped = unwrapVixMediaUrl(full);
      const u = new URL(unwrapped);
      if (u.protocol !== "https:" || !isProxyableHost(u.hostname)) return full;
      return `/media?url=${encodeURIComponent(unwrapped)}`;
    } catch {
      return full;
    }
  });
  // 3. Bare non-# URI lines (relative variant/segment/key names).
  out = out
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      if (t.startsWith("/api/") || t.startsWith("/media")) return line;
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("/")) return line;
      return proxied(t) ?? line;
    })
    .join("\n");
  return out;
}

/**
 * vixsrc's master lists variants as https://vixsrc.to/media?url=<inner> —
 * unwrap those to their INNER url so we don't double-proxy. Handles
 * double-nested wrappers by looping (max 3).
 */
function unwrapVixMediaUrl(full) {
  let cur = full;
  for (let i = 0; i < 3; i++) {
    try {
      const u = new URL(cur);
      if (u.hostname !== "vixsrc.to" && u.hostname !== "www.vixsrc.to") return cur;
      if (!u.pathname.startsWith("/media")) return cur;
      const inner = u.searchParams.get("url");
      if (!inner) return cur;
      const innerUrl = new URL(inner);
      if (!isProxyableHost(innerUrl.hostname)) return cur;
      cur = inner;
    } catch {
      return cur;
    }
  }
  return cur;
}

function sniffPlaylist(bytes) {
  return (
    bytes.length > 6 &&
    bytes[0] === 0x23 && // #
    bytes[1] === 0x45 && // E
    bytes[2] === 0x58 && // X
    bytes[3] === 0x54 && // T
    bytes[4] === 0x4d && // M
    bytes[5] === 0x33 && // 3
    bytes[6] === 0x55 // U
  );
}

async function gunzipIfNeeded(raw) {
  if (!(raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b)) return raw;
  try {
    if (typeof DecompressionStream === "undefined") return raw;
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return buf.length > 0 ? buf : raw;
  } catch {
    return raw;
  }
}

async function resolvePlaylist(type, id, season, episode, lang) {
  const mediaPath = type === "tv" ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
  const referer = `https://vixsrc.to/${mediaPath}`;

  const apiRes = await fetchWithTimeout(`https://vixsrc.to/api/${mediaPath}`, {
    headers: {
      "User-Agent": UA,
      Referer: referer,
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });
  if (!apiRes.ok) throw new Error(`vixsrc api ${apiRes.status}`);
  const apiCt = apiRes.headers.get("content-type") || "";
  if (!apiCt.includes("json")) throw new Error("vixsrc api returned non-JSON");
  const apiJson = await apiRes.json();
  if (!apiJson.src || typeof apiJson.src !== "string" || !apiJson.src.startsWith("/")) {
    throw new Error("vixsrc api returned no src");
  }

  const embedRes = await fetchWithTimeout(`https://vixsrc.to${apiJson.src}`, {
    headers: { "User-Agent": UA, Referer: referer, "Cache-Control": "no-cache" },
  });
  if (!embedRes.ok) throw new Error(`vixsrc embed ${embedRes.status}`);
  const html = await embedRes.text();

  const urlMatch = html.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?url:\s*'([^']+)'/);
  if (!urlMatch) throw new Error("no master playlist in embed page");

  const grab = (key) => html.match(new RegExp(`'${key}':\\s*'([^']*)'`))?.[1] ?? "";
  const thumbMatch = html.match(/window\.thumbnailsUrl\s*='([^']+)'/);

  const params = new URLSearchParams();
  const token = grab("token");
  const expires = grab("expires");
  const asn = grab("asn");
  if (token) params.set("token", token);
  if (expires) params.set("expires", expires);
  if (asn) params.set("asn", asn);
  params.set("h", "1");
  params.set("lang", lang);

  // Resolve relative masters against the vixsrc origin (never crash).
  const playlist = new URL(urlMatch[1], "https://vixsrc.to");
  if (playlist.protocol !== "https:") throw new Error("invalid master playlist url");
  for (const [k, v] of params) playlist.searchParams.set(k, v);

  // The browser cannot fetch vixsrc.to/playlist/... directly (Cloudflare).
  // Hand back the URL rewritten through our own /media proxy so hls.js plays
  // the whole chain same-origin through the worker.
  const proxiedPlaylist = `/media?url=${encodeURIComponent(playlist.toString())}`;

  let thumbs = thumbMatch?.[1] ?? null;
  if (thumbs) {
    try {
      const t = new URL(thumbs, "https://vixsrc.to");
      thumbs = t.protocol === "https:" ? t.toString() : null;
    } catch {
      thumbs = null;
    }
  }

  return {
    ok: true,
    playlistUrl: proxiedPlaylist,
    thumbnailsUrl: thumbs,
    season: type === "tv" ? (season ?? null) : null,
    episode: type === "tv" ? (episode ?? null) : null,
  };
}

/** Re-host a vixsrc playlist/segment through this worker. */
async function proxyMedia(request, url) {
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "url required" }, 400);

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "invalid url" }, 400);
  }
  // vixsrc's own /media?url=<inner> wrapper — fetch the inner URL directly
  // so we never double-proxy (loops up to 3 deep).
  if (
    (parsed.hostname === "vixsrc.to" || parsed.hostname === "www.vixsrc.to") &&
    parsed.pathname.startsWith("/media")
  ) {
    const inner = parsed.searchParams.get("url");
    if (inner) {
      try {
        parsed = new URL(unwrapVixMediaUrl(parsed.toString()));
      } catch {
        /* keep original — the host check below will reject it */
      }
    }
  }
  if (parsed.protocol !== "https:" || !isProxyableHost(parsed.hostname)) {
    return json({ error: "host not allowed" }, 403);
  }

  const rawRange = request.headers.get("range");
  let safeRange = null;
  if (rawRange) {
    const r = String(rawRange).trim().slice(0, 128);
    if (/^bytes=\d*-\d*$/.test(r)) safeRange = r;
  }
  try {
    // No `cf` cache options: vixsrc answers signed/per-token content with
    // no-store semantics, which the edge honors by default. Playlists must
    // stay fresh; segments carry their own long cache headers below.
    const upstream = await fetchWithTimeout(parsed.toString(), {
      headers: {
        "User-Agent": UA,
        Referer: "https://vixsrc.to/",
        "Accept-Language": "en-US,en;q=0.9",
        ...(safeRange ? { Range: safeRange } : {}),
      },
    });
    if (!upstream.ok) {
      const retryable = upstream.status === 429 || upstream.status >= 500;
      const retryAfter = parseRetryAfterSeconds(upstream.headers.get("retry-after") || upstream.headers.get("Retry-After"));
      return json(
        {
          error: `upstream ${upstream.status}`,
          retryable,
          ...(retryAfter != null ? { retryAfter } : {}),
        },
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    const contentType = upstream.headers.get("content-type") || "";

    // Sub-playlists sometimes arrive as text/plain or octet-stream — sniff
    // for the #EXTM3U magic instead of trusting the header. Only buffer types
    // that could plausibly be a playlist; real segments (.ts/.m4s) have
    // video/* content-types and stream through untouched below.
    if (isPlaylistContentType(contentType)) {
      // Buffer as BYTES — never route binary through .text() (it corrupts
      // non-UTF8 data like AES keys). Sniff the #EXTM3U magic from the raw
      // bytes; only decode to a string when it's genuinely a playlist.
      // Web-standard only: no Buffer — Uint8Array + TextDecoder.
      const raw = new Uint8Array(await upstream.arrayBuffer());
      const bytes = await gunzipIfNeeded(raw);
      if (sniffPlaylist(bytes)) {
        const text = new TextDecoder().decode(bytes);
        const rewritten = rewriteBody(text, parsed);
        return new Response(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
            // Public resolver: browsers fetch cross-origin, so CORS is
            // required. Hotlinking is inherent to a public resolver —
            // rate-limit at the Cloudflare zone (WAF rate rules).
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      // Not a playlist — send the exact bytes.
      const ct = contentType.includes("html") ? "application/octet-stream" : contentType || "application/octet-stream";
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": ct,
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Binary pass-through (segments/init/aes key). Forward Range reply.
    // upstream.body streams straight through — no buffering, no timeout risk.
    const isPartial = upstream.status === 206;
    const headers = new Headers({
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": isPartial ? "private, no-store" : "public, max-age=86400",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    });
    if (isPartial) headers.set("Vary", "Range");
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "proxy failed" }, 502);
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, ts: new Date().toISOString(), runtime: "workers" });
    }

    if (url.pathname === "/media") {
      return proxyMedia(request, url);
    }

    if (url.pathname !== "/" && url.pathname !== "/stream") {
      return json({ error: "not found" }, 404);
    }

    let params;
    try {
      params = parseMediaParams(url.searchParams);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "bad request" }, 400);
    }

    const lang = (env && env.VIX_LANG) || "en";
    try {
      return json(await resolvePlaylist(params.type, params.id, params.season, params.episode, lang));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "vix resolution failed" }, 502);
    }
  },
};

export default worker;
