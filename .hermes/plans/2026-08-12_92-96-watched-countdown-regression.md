# Plan — tvtime: 92%/96% watched + countdown not firing

**Date:** 2026-08-12 · **Status:** PLAN (no code changed)

## The regression question — answered: NO, my commits are clean

`git show --stat 8477a8b` (today's db fix) touched 8 files:
- 4 × `.hermes/plans/*.md` (docs, unrelated)
- `lib/db.ts` (retry budget 5→8)
- `app/api/watch/route.ts` + `app/api/movie-watch/route.ts` (wrapped writes in `withDbRetry`)
- 3 page reads (`movies`, `movie/[id]`, `show/[id]`)
- `vercel.json`

**Zero player files.** No commit has touched `components/vix-player.tsx`,
`show-detail-client.tsx`, `lib/player-progress.ts`, or `up-next-card.tsx` since
`e013ce7` (Aug 10, the commit where 92/96 was confirmed working). The 92%/96%
detection and countdown are 100% untouched by my changes.

## What's actually broken (evidence)

Live logs show **zero** `POST /api/playback` (progress save) and **zero**
`POST /api/watch` (mark watched) during his recent viewing. The player is not
emitting progress *at all*.

The 92% "ended" and 96% "nearEnd" both depend on `remotePositionRef` /
`remoteDurationRef` in `vix-player.tsx`, which are fed ONLY by the iframe
embed's `PLAYER_EVENT` postMessage bridge (line 1296-1324). No progress events
→ no 92% mark-watched → no 96% countdown.

## Root-cause hypothesis

The **vix resolver is DEAD** (404 — old Railway account deleted the service).
Native hls.js playback (which drives progress reliably via `video.timeupdate`)
is therefore down, forcing playback onto embeds. The active embed source is
either not relaying `PLAYER_EVENT` or not playing at all — so progress never
crosses 92%/96%.

This is an infrastructure casualty of the account migration, not a code
regression.

## Plan

1. **Confirm the active source + bridge health** (read-only)
   - In the live player, capture `PLAYER_EVENT` postMessage traffic (browser
     console `window.addEventListener("message", …)`) to see if the embed is
     posting `{type:"PLAYER_EVENT", currentTime, duration}`.
   - Identify which source is actually playing (VidFast/VidLink/…).

2. **Priority fix — restore the vix resolver** (native playback = reliable
   progress). Blocked on one thing: a Railway API token for the new account.
   Deploy `posigit/vix@main` (already cloned at `~/Desktop/tvtime-data/vix`),
   point Vercel `VIX_RESOLVER_URL` at it, redeploy.

3. **If embeds must carry it** — fix/verify the `PLAYER_EVENT` bridge for the
   active source, or add a host-side time-based fallback (estimate position
   from wall-clock when the iframe won't relay).

4. **Verify** — watch an episode past 92%: confirm `POST /api/playback` +
   `POST /api/watch` appear in logs, mark-watched sticks in `watch_history`,
   and the UpNextCard countdown (10→1) renders.

## Decision needed from Posi

Drop the Railway token (Dashboard → Settings → Tokens) to unblock step 2 — that
restores native playback and is the highest-leverage fix. Without it, we're
chasing the embed bridge.
