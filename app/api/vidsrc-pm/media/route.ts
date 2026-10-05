import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "zlib";
import {
  signVidsrcPmProxyUrl,
  verifyVidsrcPmProxyUrl,
  vidsrcPmAllowedHost,
  VIDSRC_PM_REFERER,
} from "@/lib/vidsrc-pm";
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
 * vidsrc.pm media proxy.
 *
 * netocdn playlists set ACAO=https://vidsrc.pm only, and their bare
 * /segment refs 403 without that Referer — the browser can never read them
 * from the app origin. This route re-hosts playlists + segments (the same
 * role /api/vidsrc-sh/media plays for data.vidsrc.sh):
 *
 * Contract (stream route hands OUT these URLs):
 *   /api/vidsrc-pm/media?url=<enc(https://p1.netocdn.site/proxy|/segment?...)>&exp=..&sig=..
 *
 * Behavior:
 *   - Require expiring HMAC (no open proxy).
 *   - Playlists (mpegurl by content-type OR #EXTM3U sniffing): rewrite every
 *     ref — bare relative /segment lines resolve against the netocdn base —
 *     through this proxy (host allowlist + re-signed).
 *   - Segments / init / keys: byte pass-through with strict Range support.
 */
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 15_000;

/** Collect absolute refs, sign them, then rewrite — async WebCrypto signing. */
async function rewriteBodySigned(body: string, base: URL): Promise<string> {
  const refs = new Set<string>();
  const collect = (ref: string) => {
    try {
      const abs = ref.startsWith("//")
        ? `${base.protocol}${ref}`
        : new URL(ref, base).toString();
      const u = new URL(abs);
      if (
        u.protocol === "https:" &&
        vidsrcPmAllowedHost(u.hostname) &&
        !isBlockedHost(u.hostname)
      ) {
        refs.add(abs);
      }
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
  // Bare relative lines (netocdn's /segment?... refs)
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("/api/")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("/")) continue;
    collect(t);
  }
  const signed = new Map<string, string>();
  await Promise.all(
    [...refs].map(async (ref) => {
      try {
        signed.set(ref, await signVidsrcPmProxyUrl(ref));
      } catch {
        /* leave unsigned — line passes through */
      }
    })
  );
  return rewritePlaylistBody(body, base, (abs) => signed.get(abs) ?? null);
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  // Only URLs minted by our own stream route (expiring HMAC) are served.
  const ok = await verifyVidsrcPmProxyUrl(
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
  if (
    parsed.protocol !== "https:" ||
    isBlockedHost(parsed.hostname) ||
    !vidsrcPmAllowedHost(parsed.hostname)
  ) {
    return NextResponse.json({ error: "host not allowed" }, { status: 403 });
  }

  const range = req.nextUrl.searchParams.get("range") ?? req.headers.get("range");
  // Strict Range: bytes=<start>-<end>, suffix, or open-ended. Reject garbage.
  let safeRange: string | null = null;
  if (range) {
    const r = range.trim().slice(0, 128);
    if (/^bytes=\d*-\d*$/.test(r) || /^\d+-\d*$/.test(r)) safeRange = r.startsWith("bytes=") ? r : `bytes=${r}`;
  }

  const doFetch = () =>
    fetchWithTimeout(
      target,
      {
        headers: {
          "User-Agent": SHARED_UA,
          Referer: VIDSRC_PM_REFERER,
          Accept: "*/*",
          ...(safeRange ? { Range: safeRange } : {}),
        },
        cache: "no-store",
      },
      UPSTREAM_TIMEOUT_MS
    );

  try {
    const upstream = await doFetch();
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
      // Non-playlist bytes behind a text content-type (e.g. HTML error page):
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
