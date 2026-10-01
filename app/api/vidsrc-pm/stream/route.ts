import { NextRequest, NextResponse } from "next/server";
import { signVidsrcPmProxyUrl, vidsrcPmResolve } from "@/lib/vidsrc-pm";
import { parseMediaParams } from "@/lib/stream-proxy";

/**
 * vidsrc.pm (Vidora) resolver endpoint.
 *
 * Same contract as /api/vidsrc-sh/stream: accept type/id/season/episode,
 * return a signed /api/vidsrc-pm/media playlist URL. The upstream playlist
 * is CORS-locked to https://vidsrc.pm (and its bare /segment refs are
 * Referer-gated), so the browser can only play it re-hosted here.
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
    const r = await vidsrcPmResolve(params);
    let playlistUrl: string;
    try {
      playlistUrl = await signVidsrcPmProxyUrl(r.playlistUrl);
    } catch {
      return NextResponse.json(
        { error: "failed to sign stream", code: "sign_failed" },
        { status: 502 }
      );
    }
    return NextResponse.json({
      playlistUrl,
      title: r.title,
      imdbId: r.imdbId,
      sourceApi: "vidsrc-pm",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "vidsrc-pm failed";
    return NextResponse.json(
      {
        error: message,
        code: "upstream_unreachable",
        detail:
          "vidsrc.pm unreachable from this deployment (blocked, down, or format change).",
      },
      { status: 502 }
    );
  }
}
