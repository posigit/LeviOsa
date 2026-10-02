/**
 * Download source/mirror selection rules. Pure (no storage, no network) so
 * they are unit-testable — see scripts/test-offline-download.ts.
 *
 * Downloads do NOT read the player's `preferredSource` anymore: the player
 * rewrites it on every hand-picked source switch (vix-player.tsx), which
 * silently reordered downloads between runs — and resolving a different
 * source than the previous run is a different cut of the video, which the
 * engine's rendition guard treats as "new file" and wipes (see the wipe at
 * lib/offline/engine.ts downloadAttempt). The cascade is fixed instead.
 */
import type { StreamSource } from "@/lib/player-native-types";

/**
 * The fixed download cascade. vidsrc-sh first — it is the source downloads
 * historically landed on and the one proven stable for unattended runs;
 * vidsrc-pm and vix follow. goated is parked (backend NXDOMAIN since
 * 2026-09-23) and embed sources can never download, so neither is listed.
 */
export const DOWNLOAD_SOURCES: StreamSource[] = ["vidsrc-sh", "vidsrc-pm", "vix"];

/**
 * Resolve verdicts meaning the title will NEVER work on that source — only
 * these let a pinned source give way to the next candidate. Anything else
 * (no code, timeout, 429/5xx, `blocked`, `upstream_unreachable`) is
 * transient: the run stops with a retryable error so the auto-retry
 * re-pins to the same source instead of flipping to a different cut.
 */
const PERMANENT_RESOLVE_CODES = new Set(["not_found", "no_streams"]);

/**
 * The source a run that already owns bytes must stay on. Normalizes the
 * goated backend names (`valenox`/`orbit` → `goated`) and returns null for
 * parked or unknown sources — such records just use the plain cascade.
 */
export function pinnedDownloadSource(
  usedSource: string | undefined,
  hasProgress: boolean
): StreamSource | null {
  if (!hasProgress || !usedSource) return null;
  const source =
    usedSource === "valenox" || usedSource === "orbit" ? "goated" : usedSource;
  return (DOWNLOAD_SOURCES as string[]).includes(source)
    ? (source as StreamSource)
    : null;
}

/** Candidate order for one run: pinned source first (bytes at stake), then the fixed cascade, deduped. */
export function downloadCandidates(pinned: StreamSource | null): StreamSource[] {
  return [...(pinned ? [pinned] : []), ...DOWNLOAD_SOURCES].filter(
    (s, i, a) => a.indexOf(s) === i
  );
}

/** True when a failed resolve on the pinned source gives way to the next candidate. */
export function pinnedResolveGivesWay(code: string | undefined): boolean {
  return code != null && PERMANENT_RESOLVE_CODES.has(code);
}

/**
 * Stable identity of a mirror. Signed proxy URLs re-sign (and the resolver
 * rotates their order) on every resolve, so a resume matches by the wrapped
 * target's origin+path — never by the exact URL. Plain URLs drop query/hash.
 */
export function mirrorIdentity(playlistUrl: string): string {
  const query = playlistUrl.indexOf("?");
  if (query >= 0) {
    for (const pair of playlistUrl.slice(query + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      let param = pair.slice(0, eq);
      try {
        param = decodeURIComponent(param);
      } catch {
        /* keep raw */
      }
      if (param !== "url") continue;
      let target = pair.slice(eq + 1);
      try {
        target = decodeURIComponent(target);
      } catch {
        /* keep raw */
      }
      return stripQueryHash(target);
    }
  }
  return stripQueryHash(playlistUrl);
}

function stripQueryHash(u: string): string {
  return u.split("#")[0]!.split("?")[0]!;
}
