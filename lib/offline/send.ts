/**
 * POST that survives losing the network.
 *
 * The service worker refuses every non-GET request (`public/sw.js` returns
 * before the fetch handler), so an offline "mark watched" can never be
 * intercepted — it has to be caught here and parked in the same outbox the
 * resume-position saves use. The queue drains on `online`, on startup and on
 * tab focus via `initPlaybackOutbox()`.
 *
 * Deliberately never throws: callers already treat a non-OK response as
 * failure, so a parked action answers `200` and the caller's optimistic UI
 * stays put until the replay lands.
 */

import { enqueuePlayback } from "@/lib/offline/store";

const HEADERS = { "Content-Type": "application/json" };

/** True when the call was parked locally instead of reaching the server. */
export function queuedOffline(res: Response): boolean {
  return res.headers.get("x-offline-queued") === "1";
}

/**
 * POST `body` to `url`; on a network failure park it in the outbox and hand
 * back a synthetic 200 carrying `x-offline-queued: 1`.
 *
 * The URL plus the serialized body is the coalesce key, so re-tapping the
 * same action offline replaces the pending copy rather than stacking a
 * duplicate, while two different episodes keep two entries.
 */
export async function postJsonOffline(
  url: string,
  body: unknown
): Promise<Response> {
  const text = JSON.stringify(body);
  try {
    return await fetch(url, {
      method: "POST",
      headers: HEADERS,
      body: text,
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    await enqueuePlayback({
      params: `${url}|${text}`,
      method: "POST",
      body: text,
      url,
    });
    return new Response(JSON.stringify({ ok: true, offlineQueued: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-offline-queued": "1" },
    });
  }
}
