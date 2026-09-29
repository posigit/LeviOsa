/**
 * POST that survives losing the network.
 *
 * The service worker refuses every non-GET request (`public/sw.js` returns
 * before the fetch handler), so an offline "mark watched" can never be
 * intercepted — it has to be caught here and parked in the same outbox the
 * resume-position saves use. The queue drains on `online`, on startup and on
 * tab focus via `initPlaybackOutbox()`.
 *
 * Deliberately never throws: failures (network or status) are parked and
 * answered `200`, so the caller's optimistic UI stays put until the replay
 * lands.
 */

import { enqueuePlayback } from "@/lib/offline/store";

const HEADERS = { "Content-Type": "application/json" };

/** True when the call was parked locally instead of reaching the server. */
export function queuedOffline(res: Response): boolean {
  return res.headers.get("x-offline-queued") === "1";
}

/**
 * POST `body` to `url`; park it in the outbox whenever it does not land on
 * the server (network failure OR non-OK status) and hand back a synthetic 200
 * carrying `x-offline-queued: 1`.
 *
 * Non-OK used to fall through untouched: a 401/500 during an episode's
 * auto-mark silently dropped the watched action. Parked entries are
 * classified by the drain — permanent 4xx leave, everything else retries.
 *
 * The URL plus the serialized body is the coalesce key, so re-tapping the
 * same action offline replaces the pending copy rather than stacking a
 * duplicate, while two different episodes keep two entries.
 */
function parkedResponse(): Response {
  return new Response(JSON.stringify({ ok: true, offlineQueued: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "x-offline-queued": "1" },
  });
}

export async function postJsonOffline(
  url: string,
  body: unknown
): Promise<Response> {
  const text = JSON.stringify(body);
  const park = async (): Promise<Response> => {
    await enqueuePlayback({
      params: `${url}|${text}`,
      method: "POST",
      body: text,
      url,
    });
    return parkedResponse();
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: HEADERS,
      body: text,
      credentials: "same-origin",
      keepalive: true,
    });
    if (res.ok) return res;
    return await park();
  } catch {
    return await park();
  }
}
