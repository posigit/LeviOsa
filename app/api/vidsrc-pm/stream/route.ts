import { NextRequest, NextResponse } from "next/server";
import {
  signVidsrcPmProxyUrl,
  vidsrcPmResolve,
  VidsrcPmError,
} from "@/lib/vidsrc-pm";
import { parseMediaParams } from "@/lib/stream-proxy";

/**
 * vidsrc.pm (Vidora) resolver endpoint.
 *
 * Same contract as /api/vidsrc-sh/stream: accept type/id/season/episode,
 * return a signed /api/vidsrc-pm/media playlist URL. The upstream playlist
 * is CORS-locked to https://vidsrc.pm (and its bare /segment refs are
 * Referer-gated), so the browser can only play it re-hosted here.
 *
 * Failures pass through the REAL upstream status (404 not-on-source,
 * 401/403 blocked, 429 rate-limited, 5xx down) — the player shows it so a
 * dead source can be identified and removed, never a blanket 502.
 */
export const dynamic = "force-dynamic";

const CODE_DETAIL: Record<string, string> = {
  not_found: "vidsrc.pm has no stream for this title/episode.",
  blocked: "vidsrc.pm rejected the player key or blocked this deployment.",
  rate_limited: "vidsrc.pm rate-limited the resolver — retry shortly.",
  bad_payload: "vidsrc.pm returned a payload we can't use (format change?).",
};

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
    const vp = err instanceof VidsrcPmError ? err : null;
    const status = vp?.status ?? 502;
    const code = vp?.code ?? "upstream_unreachable";
    return NextResponse.json(
      {
        error: message,
        code,
        detail:
          CODE_DETAIL[code] ??
          "vidsrc.pm unreachable from this deployment (blocked, down, or format change).",
      },
      { status }
    );
  }
}
