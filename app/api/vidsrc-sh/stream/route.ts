import { NextRequest, NextResponse } from "next/server";
import { signProxyUrl, vidsrcShResolve } from "@/lib/vidsrc-sh";
import { parseMediaParams } from "@/lib/stream-proxy";

/**
 * data.vidsrc.sh resolver endpoint.
 *
 * Mirrors /api/vixsrc/stream's shape where it matters: accept
 * type/id/season/episode, return direct stream URLs (decrypted server-side).
 * Production note (2026-10-10): the whole gated chain (vs_src -> landing ->
 * player -> data API -> decryptor fetch) runs fine from Cloudflare Workers
 * egress; what 502d every resolve there was dynamic WebAssembly compilation
 * ("Wasm code generation disallowed by embedder"). Decryption is now a
 * pure-JS ChaCha20 port (lib/vidsrc-sh.ts), so this route resolves on both
 * Node and Workers. If data.vidsrc.sh ever starts 403ing datacenter egress,
 * failures surface here as `blocked` and the player falls through.
 */
export const dynamic = "force-dynamic";

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

  try {
    const r = await vidsrcShResolve(params);
    if (r.urls.length === 0) {
      return NextResponse.json(
        {
          error: "no streams for this title",
          code: "no_streams",
          title: r.title,
          imdbId: r.imdbId,
        },
        { status: 404 }
      );
    }
    const playlistUrls: string[] = [];
    for (const u of r.urls) {
      try {
        playlistUrls.push(await signProxyUrl(u));
      } catch {
        /* skip unsignable */
      }
    }
    if (playlistUrls.length === 0) {
      return NextResponse.json(
        { error: "failed to sign streams", code: "sign_failed" },
        { status: 502 }
      );
    }
    const subtitles = [];
    for (const sub of r.subtitles.slice(0, 8)) {
      try {
        // Same proxy as the playlist. The page cannot fetch the CDN URL.
        subtitles.push({
          language: sub.language,
          label: sub.label,
          url: await signProxyUrl(sub.url),
        });
      } catch {
        /* one bad target skips */
      }
    }
    return NextResponse.json({
      // Proxied master: tokens are IP-bound to this deployment, so the
      // browser must go through /api/vidsrc-sh/media (which mints + proxies).
      // Signed with expiry: the media route only serves URLs minted here.
      playlistUrl: playlistUrls[0],
      playlistUrls,
      title: r.title,
      imdbId: r.imdbId,
      fileName: r.fileName,
      thumbnailsUrl: r.thumbnailsUrl,
      subtitles,
      sourceApi: "vidsrc-sh",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "vidsrc-sh failed";
    // The lib throws status-bearing messages ("vidsrc.sh api 404",
    // "wasm 403", "token endpoint 502") — pass the real status through so
    // the player can show "vidsrc-sh ✗ 404" instead of a blanket 502.
    const m = /\b([45]\d{2})\b/.exec(message);
    const upstream = m ? Number(m[1]) : null;
    const status = upstream && upstream >= 400 && upstream <= 599 ? upstream : 502;
    const code =
      status === 404 ? "not_found" : status === 403 ? "blocked" : "upstream_unreachable";
    return NextResponse.json(
      {
        error: message,
        code,
        detail:
          code === "not_found"
            ? "data.vidsrc.sh has no stream for this title/episode."
            : "data.vidsrc.sh unreachable from this deployment (blocked, down, or format change).",
      },
      { status }
    );
  }
}
