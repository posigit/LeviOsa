import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "zlib";
import {
  applyVidsrcToken,
  signProxyUrl,
  verifyProxyUrl,
  vidsrcShOrigin,
  vidsrcShRefreshToken,
  vidsrcShToken,
} from "@/lib/vidsrc-sh";
import {
  SHARED_UA,
  couldBePlaylistContentType,
  fetchWithTimeout,
  isBlockedHost,
  isPlaylistBytes,
  parseRetryAfterSeconds,
  rewritePlaylistBody,
} from "@/lib/stream-proxy";

/**
 * vidsrc-sh media proxy.
 *
 * Stream URLs are JWT-gated AND IP-bound (/24) to the minter's network, so
 * the browser can never fetch them directly — the token would fail the IP
 * check. This route mints server-side and re-hosts playlists + segments on
 * the app's own origin so hls.js plays same-origin (and downloads work).
 *
 * Contract (stream route hands OUT these URLs):
 *   /api/vidsrc-sh/media?url=<enc(https://<host>/pl/<gzip-blob>)>&exp=..&sig=..
 *
 * Behavior:
 *   - Require expiring HMAC (no open proxy).
 *   - Ensure ?token= (mint per-origin, cached ~1h) before fetching.
 *   - Playlists (m3u8 by content-type OR #EXTM3U sniffing): rewrite EVERY
 *     absolute https URL through this proxy (SSRF-guarded).
 *   - Segments / init / keys: byte pass-through with strict Range support.
 */
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Referer the real vidsrc.sh embed player sends when fetching segments.
 * Segment CDNs hotlink-guard on this: the previous hardcoded
 * cloudorchestranova.com value loaded playlists but 403'd segments on some
 * hosts. Per-host overrides for future picky CDNs; default mirrors the embed.
 */
const REFERER_OVERRIDES: Record<string, string> = {};

/** Pre-change global default, kept as the 403 fallback below. */
const LEGACY_REFERER = "https://cloudorchestranova.com/";

function refererFor(target: URL): string {
  const override = REFERER_OVERRIDES[target.hostname.toLowerCase()];
  if (override) return override;
  return "https://vidsrc.sh/";
}

/** Collect absolute refs, sign them, then rewrite — async WebCrypto signing. */
async function rewriteBodySigned(body: string, base: URL): Promise<string> {
  const refs = new Set<string>();
  const collect = (ref: string) => {
    try {
      const abs = ref.startsWith("//")
        ? `${base.protocol}${ref}`
        : new URL(ref, base).toString();
      const u = new URL(abs);
      if (u.protocol === "https:" && !isBlockedHost(u.hostname)) refs.add(abs);
    } catch {
      /* skip */
    }
  };
  // Quoted URI attrs
  for (const m of body.matchAll(/URI="([^"]*)"/g)) {
    const ref = m[1];
    if (ref && !ref.startsWith("data:")) collect(ref);
  }
  // Absolute URLs (port-aware)
  for (const m of body.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?(\/[^\s"'<>]*)/gi)) {
    collect(m[0]);
  }
  // Bare relative lines
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("/api/")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("/")) continue;
    collect(t);
  }
  const signed = new Map<string, string>();
  for (const ref of refs) {
    try {
      signed.set(ref, await signProxyUrl(ref));
    } catch {
      /* leave unsigned — line passes through */
    }
  }
  return rewritePlaylistBody(body, base, (abs) => signed.get(abs) ?? null);
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  // Only URLs minted by our own stream route (expiring HMAC) are served.
  const ok = await verifyProxyUrl(
    target,
    req.nextUrl.searchParams.get("sig"),
    req.nextUrl.searchParams.get("exp")
  ).catch(() => false);
  if (!ok) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" || isBlockedHost(parsed.hostname)) {
    return NextResponse.json({ error: "host not allowed" }, { status: 403 });
  }

  // Mint the playback token server-side (IP-bound to THIS deployment).
  // Egress IPs rotate: a cached token dies with its old /24, so a 401/403 on
  // a minted URL refreshes once instead of failing the whole download.
  let fetchUrl = target;
  let mintedOrigin: string | null = null;
  try {
    if (!parsed.searchParams.has("token")) {
      const origin = vidsrcShOrigin(target);
      if (!origin) throw new Error("unparseable origin");
      const token = await vidsrcShToken(origin);
      fetchUrl = applyVidsrcToken(target, token);
      mintedOrigin = origin;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "token mint failed" },
      { status: 502 }
    );
  }

  const range = req.nextUrl.searchParams.get("range") ?? req.headers.get("range");
  // Strict Range: bytes=<start>-<end>, suffix, or open-ended. Reject garbage.
  let safeRange: string | null = null;
  if (range) {
    const r = range.trim().slice(0, 128);
    if (/^bytes=\d*-\d*$/.test(r) || /^\d+-\d*$/.test(r)) safeRange = r.startsWith("bytes=") ? r : `bytes=${r}`;
  }

  const doFetch = (url: string, referer?: string) =>
    fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": SHARED_UA,
          Referer: referer ?? refererFor(parsed),
          Accept: "*/*",
          ...(safeRange ? { Range: safeRange } : {}),
        },
        cache: "no-store",
      },
      UPSTREAM_TIMEOUT_MS
    );

  try {
    let upstream = await doFetch(fetchUrl);
    // Stale IP-bound token (egress rotated after mint): refresh once.
    if (upstream.status === 401 || upstream.status === 403) {
      if (mintedOrigin) {
        try {
          await upstream.arrayBuffer().catch(() => {});
        } catch {
          /* free the connection — best effort */
        }
        try {
          const fresh = await vidsrcShRefreshToken(mintedOrigin);
          fetchUrl = applyVidsrcToken(target, fresh);
          upstream = await doFetch(fetchUrl);
        } catch {
          /* refresh failed — fall through to the error below */
        }
      }
    }
    // Referer fallback: the default mirrors the vidsrc.sh embed player, but
    // some segment hosts only accept the legacy cloudorchestranova value
    // (which used to be the global default). One retry, 403-only, then out.
    if (upstream.status === 403 && refererFor(parsed) !== LEGACY_REFERER) {
      try {
        await upstream.arrayBuffer().catch(() => {});
      } catch {
        /* free the connection — best effort */
      }
      upstream = await doFetch(fetchUrl, LEGACY_REFERER);
    }
    if (!upstream.ok) {
      const retryAfter = parseRetryAfterSeconds(upstream.headers.get("retry-after"));
      return NextResponse.json(
        {
          error: `upstream ${upstream.status}`,
          retryable: upstream.status === 429 || upstream.status >= 500,
          ...(retryAfter != null ? { retryAfterSeconds: retryAfter } : {}),
        },
        {
          status:
            upstream.status >= 400 && upstream.status < 600
              ? upstream.status
              : 502,
        }
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    // A 206 is already the requested byte window. Sniffing it and answering
    // 200 drops Content-Range, and the downloader then treats the slice as
    // the whole file (empty gap once start > 0).
    if (upstream.status !== 206 && couldBePlaylistContentType(contentType)) {
      let buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try {
          buf = gunzipSync(buf);
        } catch {
          /* corrupt gzip — fall through to raw handling below */
        }
      }
      if (isPlaylistBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))) {
        const rewritten = await rewriteBodySigned(buf.toString("utf8"), parsed);
        return new NextResponse(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }
      // Non-playlist bytes behind a text content-type (e.g. HTML challenge):
      // never serve as HTML same-origin — force download type.
      const ct = contentType.includes("html") ? "application/octet-stream" : contentType || "application/octet-stream";
      return new NextResponse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
        status: 200,
        headers: {
          "Content-Type": ct,
          "Content-Length": String(buf.length),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }

    const isPartial = upstream.status === 206;
    const headers = new Headers({
      "Content-Type": contentType || "application/octet-stream",
      // 206 partials must not be cached publicly — poison risk.
      "Cache-Control": isPartial ? "private, no-store" : "public, max-age=86400",
      "Accept-Ranges": "bytes",
      Vary: "Range",
    });
    if (upstream.headers.get("content-range")) {
      headers.set("Content-Range", upstream.headers.get("content-range")!);
    }
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "proxy failed" },
      { status: 502 }
    );
  }
}
