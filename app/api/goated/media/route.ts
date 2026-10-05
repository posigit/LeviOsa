import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "zlib";
import { GOATED_ORIGIN } from "@/lib/goated";
import {
  SHARED_UA,
  couldBePlaylistContentType,
  fetchWithTimeout,
  isPlaylistBytes,
  parseRetryAfterSeconds,
  rewritePlaylistBody,
} from "@/lib/stream-proxy";

/**
 * goated media proxy.
 *
 * goated's playlists (cdn.reallyfast.xyz) and segments (hls.cdn8012.workers.dev)
 * are referer + CORS locked to https://goated.cx. This route re-hosts them on
 * the app's own origin so hls.js can play them same-origin.
 * Valenox backend serves through hls-proxy.cdn8012.workers.dev (same family,
 * allowlisted too — 2026-08-09).
 *
 * Contract (stream route hands OUT these URLs):
 *   /api/goated/media?url=<enc(https://cdn.reallyfast.xyz/playlist/xxx.m3u8?t=..&s=..)>
 *
 * Behavior:
 *   - Fetch the target with Referer: https://goated.cx, forward validated Range.
 *   - If the body is a playlist (m3u8 OR sniffed #EXTM3U incl. gzipped),
 *     rewrite EVERY absolute URL through this proxy.
 *   - Otherwise pass bytes through with Range support.
 */

export const dynamic = "force-dynamic";

// Hosts whose absolute URLs we rewrite into proxy calls.
const REWRITE_HOSTS = new Set([
  "cdn.reallyfast.xyz",
  "hls.cdn8012.workers.dev",
  "hls-proxy.cdn8012.workers.dev", // Valenox backend (same reallyfast family)
]);

function toProxy(full: string): string | null {
  try {
    const u = new URL(full);
    if (u.protocol !== "https:") return null;
    if (!REWRITE_HOSTS.has(u.hostname)) return null;
    return `/api/goated/media?url=${encodeURIComponent(full)}`;
  } catch {
    return null;
  }
}

function rewriteBody(body: string, base: URL): string {
  return rewritePlaylistBody(body, base, toProxy);
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  // Only proxy the hosts we intend to — never an open redirect.
  // NOTE: open-proxy residual — anyone can proxy these 3 hosts. This is
  // intentional (same-origin playback) but rate-limit at edge (Vercel Firewall
  // / middleware) to avoid bandwidth burn.
  if (parsed.protocol !== "https:" || !REWRITE_HOSTS.has(parsed.hostname)) {
    return NextResponse.json(
      { error: "host not allowed" },
      { status: 403 }
    );
  }

  const rawRange = req.headers.get("range");
  let safeRange: string | null = null;
  if (rawRange) {
    const r = rawRange.trim().slice(0, 128);
    if (/^bytes=\d*-\d*$/.test(r)) safeRange = r;
  }

  try {
    const upstream = await fetchWithTimeout(
      target,
      {
        headers: {
          Referer: GOATED_ORIGIN + "/",
          Origin: GOATED_ORIGIN,
          "User-Agent": SHARED_UA,
          Accept: "*/*",
          ...(safeRange ? { Range: safeRange } : {}),
        },
        cache: "no-store",
      },
      15_000
    );
    if (!upstream.ok) {
      const retryAfter = parseRetryAfterSeconds(upstream.headers.get("retry-after"));
      return NextResponse.json(
        {
          error: `upstream ${upstream.status}`,
          retryable: upstream.status === 429 || upstream.status >= 500,
          ...(retryAfter != null ? { retryAfterSeconds: retryAfter } : {}),
        },
        { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 }
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    // A 206 is already the requested byte window. Sniffing it and answering
    // 200 drops Content-Range, and the downloader then treats the slice as
    // the whole file.
    if (upstream.status !== 206 && couldBePlaylistContentType(contentType)) {
      const raw = new Uint8Array(await upstream.arrayBuffer());
      let bytes = raw;
      if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
        try {
          const out = gunzipSync(Buffer.from(raw));
          bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        } catch {
          // Corrupt gzip: fall through to raw bytes (do NOT serve empty).
        }
      }
      if (isPlaylistBytes(bytes)) {
        const text = Buffer.from(bytes).toString("utf8");
        const rewritten = rewriteBody(text, parsed);
        return new NextResponse(rewritten, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }
      // Sniffed non-playlist: pass exact bytes, never empty-string fallback.
      const ct = contentType.includes("html") ? "application/octet-stream" : contentType || "application/octet-stream";
      return new NextResponse(bytes, {
        status: 200,
        headers: {
          "Content-Type": ct,
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }

    // Binary pass-through (segments/init/aes key). Forward Range reply.
    const isPartial = upstream.status === 206;
    const headers = new Headers({
      "Content-Type": contentType || "application/octet-stream",
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
