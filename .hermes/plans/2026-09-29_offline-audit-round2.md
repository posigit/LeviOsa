# Offline/download audit — round 2 (2026-09-29)

Re-run of the deferred-finding sweep after `7b34962` ("fix: offline player — auto-mark,
seeking, hole recovery, captured stream subs"). The original round-1 list (previous session)
was never persisted, so this file is the canonical list of **deferred findings**.

## Round-2 status (this session)

**Fixed pass 1 (8):** #1 quota pre-check, #2 quota own-bytes exclusion, #3 rendition-wipe
persist-before-delete, #4 outbox serialized read-modify-write, #6 offline mirror follows
clear rules (ended/92%/cleared), #9 non-OK POSTs parked instead of dropped, #10 outbox
attempts no longer burned by 5xx/network, #20 SW suffix-range 416. Marked ✅ below.

**Fixed pass 2 (5 + 1 partial + 1 not-a-bug):** #7 native-HLS error/hole recovery,
#11 stale intent sweep + #12 attach-window pause/cancel re-check, #14 synthetic master for
captured CC on muxed-audio tops (test added), #16 autoAttempts reset on completion,
#5 **partial** (same-key cross-tab run fence via Web Locks `ifAvailable`; whole-manifest
write clobber still open), #13 verified working (not a bug — refresh rides
`PieceDownloadError("auth")`).

**Stashed / deferred (the rest):** #8 (blocked on server tombstones — unsafe otherwise),
#15, #17–#35. Biggest open: #5b per-row manifest storage, #17/#18 offline subs UX,
#19 source picker, #21–#35 service-worker/UX items.

- Method: 4 parallel sweeps (store/UI, engine/hls, service worker, offline player) + spot-checks.
- Line numbers verified against commit `7b34962`. Findings marked ✓ were re-checked against
  source while writing this file; the rest are sweep results (locations accurate, exact
  behavior should be re-confirmed before fixing).
- Constraint carried from round 1: these must be fixed carefully — the download engine's
  resilience characteristics were explicitly preserved on purpose.

## Round-4 status (2026-09-29)

**Fixed (7):** #15 hidden-bandwidth estimate seed (`7f90d2c`), #17 offline subs re-inject after
video remount (`7c25a61`), #18 Subtitle Sync wired to stored offline subs (`891e8a9`),
#19 stream source picker locked offline (`c7bc9cb`), #25 stalled library grid rows marked
stale with tap-to-retry (`fcb46b4`), #26 `EXT-X-BYTERANGE` in either tag order (`f4b0e10`,
test `6342687`), #33 Up Next countdown pauses with the player / resets on scrub-back
(`76ce50d`). All ✅ below.

**Copy/icon polish:** offline page connection blurb removed + reconnect status split (`0599e82`),
page em-dash fragments rewritten as proper sentences (`2a2b3d6`), movie hero score fallback
uses the custom `TmdbIcon` (`8b9a618`).

**Still open:** #8 bounded auto-repair after 100% (proposed — awaiting approval), #5b per-row
manifest storage, remaining #17/#18 subs UX, #21–#35 service-worker/UX items.

## Already fixed in 7b34962 (for reference — do not re-report)

1. Offline auto-mark-watched: `onEvent` → outbox queue on `"ended"` (`offline-player-host.tsx`),
   `drainPlaybackOutbox` skips while offline, attempt cap 20.
2. Download seeking: duration fallback (`initialDuration`), `dropPendingSeek`, abort-aware
   `seekVideoElement` after seek/pause.
3. Partial-download resilience: `rec.missing[]` + `missingCount`, sampled verify (first/middle/last),
   `repairDownload()` + Partial UI (row/grid/button), playback-in-use pin, 10-min LRU floor in
   `enforceQuota`, offline fatal-path hole recovery (`OFFLINE_HOP_SECONDS`, media/network branches).
4. Captured-stream subtitles offline: `subGroup`/`parseMasterSubtitles`/`withOfflineSubtitles`,
   mirror block 3c + stored `sp` playlist + role `"s"` pieces, `parseVttTime` comma normalization.
5. Data-loss: `load()` keeps `cache=null` on IDB failure, `commitRecord` cache guard,
   `sliceToRange` refuses truncated/offset-ambiguous bodies (evict + refetch),
   hls rewriter counter only advances on countable lines.
6. Hero year restored (`app/movie/[id]/page.tsx`, `components/show-detail-client.tsx`).

---

## P0 — data loss / silent corruption

1. **✅ FIXED — `enforceQuota` destroys the whole library before refusing an oversized download**
   — `lib/offline/engine.ts:1962` (`if (need > 0)` loop). If `need > capBytes` it never fits,
   so the eviction loop removes every victim, *then* throws. User loses all downloads to learn
   one file doesn't fit. Fix: pre-check `need > capBytes` (minus freeable) and bail before evicting.

2. **✅ FIXED — Quota estimate double-counts the row's own bytes**
   — `lib/offline/engine.ts:1962-1963`: `used = usedBytes(all)` includes the *active* record's
   `bytesDone`, while `need` is the full estimated size. Inflates `used` → needless evictions of
   other rows and spurious "storage full" refusals. Fix: exclude `rec` from `used` (or subtract
   `rec.bytesDone`).

3. **✅ FIXED — Rendition wipe deletes bytes before a replacement cut exists**
   — `lib/offline/engine.ts:1531-1538`: rendition change → `deleteRecordFiles(rec)` + reset
   `bytesDone/fileUrls`, but new segments are only stored afterward. Crash/network failure in
   that window leaves a row pointing at nothing (looks "done"/repairable but files are gone).
   ✓ Verified. Fix: keep old files until the new cut has ≥1 stored segment, or mark the row
   failed/partial the moment files are deleted.

4. **✅ FIXED — Outbox read-modify-write races drop queued watched marks**
   — `lib/offline/store.ts:697-705`: drain builds its own `list`, mutates entries, then
   `saveOutbox(list.filter(...))` wholesale-overwrites — anything `enqueuePlayback` appended
   mid-drain is erased; concurrent drains in two contexts do the same. ✓ Lines verified.
   Fix: single serialized writer (in-memory promise queue) + re-read-merge before save.

5. **✅ PARTIAL — Cross-tab manifest clobber, no run fencing**
   — `store.ts` `load()` (cache shared per tab, re-read races also noted ~:176/:294) +
   `engine.ts` `activeControllers`/`ownedHere` are per-context: two tabs can both believe they
   own a run and both commit the same row, last writer wins (can regress `bytesDone`/`state`).
   Fix: `navigator.locks` or BroadcastChannel writer lease + merge-on-commit instead of
   whole-row replace.
   **Round-3 done:** same-key run fence added (`runExclusive` in `engine.ts` — Web Locks
   `ifAvailable` per key, API-guarded fallback). **Remaining:** whole-manifest single-record
   writes still clobber *other rows* when two tabs download *different* titles (needs
   per-row storage or merge-on-commit design — do not rush).

6. **✅ FIXED — Offline position mirror re-written after "finished" clears it**
   — `components/vix-player.tsx:739-745`: `writeOfflinePosition` runs before the shared save
   gates; only `createSavePosition` (:747-751) consults `endedRef`/`bookmarkClearedRef`.
   After `ended` → `clearOfflinePosition` (:761), the mirror is written again during the final
   timeupdate/idle writes → finished episode gets a resumable bookmark (no Resume dialog
   offline, next open auto-jumps into credits). ✓ Verified. Fix: gate the mirror write with the
   same `endedRef`/`bookmarkClearedRef`/92% clear rules.

## P1 — playback dead-ends / correctness

7. **✅ FIXED — Native-HLS branch has no media error handling and no offline hole recovery**
   — `lib/player-engine.ts:647` (`canPlayType("application/vnd.apple.mpegurl")`): all recovery,
   seek-attach and offline hop logic lives in the hls.js path; Safari/iOS hitting a bad stored
   segment loops on "Starting…" forever. Fix: mirror the fatal/`recoverMediaError`/hop logic for
   the native branch (at least `error` listener + reload-with-offset).

8. **⛔ DEFERRED (unsafe as-is) — Server-side clears never reach local positions (stale Resume)**
   — `store.ts` position sync skips rows with no local record (`if (!row) continue` pattern);
   a watch cleared on the server (other device) keeps its local saved position, so offline
   "Resume" reappears for something marked watched/cleared elsewhere. Reported by two sweeps.
   **Why deferred:** absence of a server row is ambiguous — it also means "offline progress
   not yet uploaded (outbox pending)". Clearing local on absence would delete legitimate
   offline positions whenever sync runs before the outbox drains. Needs server-side
   tombstones (`deletedAt`/`updatedAt` on cleared bookmarks) before this is safe to fix.

9. **✅ FIXED — Auto-mark silently dropped on non-OK response**
   — `components/offline-player-host.tsx` `handlePlayerEvent`: only catches thrown errors and
   checks `queuedOffline(res)`; `postJsonOffline` (`lib/offline/send.ts:32-56`) returns the raw
   `fetch` Response when online — a 401/500 neither queues nor throws → watched mark lost.
   Fix: `if (!res.ok) enqueuePlayback(...)` (or surface a retry).

10. **✅ FIXED — Outbox attempts burned per drain; 401 treated as retryable-until-death**
    — `store.ts:616` (`OUTBOX_MAX_ATTEMPTS = 20`), :697-705: every failed flush increments
    `attempts` for *all* entries (offline focus events are excluded, but online 5xx is not), so
    ~20 tab focus cycles delete a queued mark. Fix: don't count 5xx/network the same as 4xx;
    reset attempts on success path changes; consider time-based backoff instead of hard cap.

11. **✅ FIXED — Pause/cancel intents leak past completion**
    — `lib/offline/engine.ts:83-84`, checked at :567-583 / :837-849: an intent added while a run
    was winding down is consumed by the *next* attempt → first segment of a retry "pauses"
    immediately, and in some orderings the failure path deletes the row. Reported.

12. **✅ FIXED — Pre-controller start window: pause/cancel issued before `live.state` exists is lost**
    — `engine.ts` `startingKeys` (:457-461): intents recorded before the live entry is created
    are overwritten/ignored when the run attaches. Reported.

13. **✅ NOT A BUG — Expired-link auth refresh never fires in downloads**
    — `engine.ts downloadAttempt`: no `AuthRefresh` throw site; expired key/inits are not
    re-resolved, so a long queue crossing link expiry fails every remaining segment. Reported.
    (Streaming cascade refreshes; downloads do not.)
    **Re-verified:** the mechanism runs through `PieceDownloadError("auth")` instead —
    `classifyPieceStatus` (`hls.ts:221`) maps 401/403/signature errors to `"auth"`, and the
    mirror loop (`engine.ts` ~:1792/:1813) catches it, calls `refreshCandidate` (re-resolves
    the playlist) and retries the same mirror once. The `AuthRefresh` class itself is dead
    legacy, but refresh works. No change needed.

14. **✅ FIXED — Captured subs unreachable when the top level is a media playlist**
    — mirror else-branch: reached whenever there is no separate audio rendition (muxed audio —
    the common case), so `topText` is the variant **media** playlist; the captured
    `#EXT-X-MEDIA` rendition becomes a dead line no playlist references. Reported
    (multi-variant nested masters already fail earlier with "No video segments").
    Fix: when `isMaster && pickedVariant && subs captured`, wrap the stored variant in
    `buildOfflineMaster(audio: null)` before `withOfflineSubtitles` (engine.ts else-branch);
    regression test added in `test-offline-download.ts`.

15. **✅ FIXED — `refineEstimate` unreachable → estimates stay 0 → over-eviction**
    — engine: est refinement never runs for typical rows, so `estSize` stays 0/rough and
    `enforceQuota`/playback estimates fall back to full-bitrate math → evicts more than needed.
    Reported. Fix: seed hidden-bandwidth rows with a `fallbackBitrateBps` estimate so
    `refineEstimate` can run (`7f90d2c`).

16. **✅ FIXED — `autoAttempts` lifetime budget never resets**
    — engine auto-quality attempts are a per-row lifetime counter; a row that had a few
    transient failures months ago permanently degrades to fallback bitrate. Reported.
    Fix: reset to 0 when a run completes (`state = "done"`), alongside the existing
    manual-retry reset in `resumeDownload`.

## P2 — offline UX / service worker

17. **✅ FIXED — Stored subs injected once per mount; video remount loses them**
    — `components/vix-player.tsx:1900` (`offlineSubInjectedRef`): a remount (retry, source
    switch, error reload) clears tracks but doesn't re-inject stored VTT; stale injected tracks
    can also double-draw with native CC. Reported (✓ flag verified). Fix: track the injected
    video element and re-inject when it changes (`7c25a61`).

18. **✅ FIXED — Subtitle Sync (delay) is a no-op offline**
    — `vix-player.tsx:463` `externalVttRef` is never set on the stored-VTT path, so the delay
    slider does nothing for downloads. Reported (✓ ref verified). Fix: set the ref on the
    stored-VTT path so re-timing works (`891e8a9`).

19. **✅ FIXED — Stream source picker is live while offline**
    — top-chrome picker writes `preferredSource` and triggers attach; offline it clobbers the
    saved preference and forces a reload loop. Reported. Fix: `useOnline` disables the picker
    with an "Offline" label (`c7bc9cb`).

20. **✅ FIXED — SW suffix Range `bytes=-N` → 416**
    — `public/sw.js:433-447` (416 sites at :437/:444): `end = m[2]` is empty for suffix ranges;
    must be `total-1`. Reported by clients using suffix ranges.

21. **✓ `STATIC_CACHE` grows forever**
    — `sw.js:370` trims only `IMAGE_CACHE`; `STATIC_CACHE` (opens at :255, defined :17) is never
    trimmed between VERSION bumps → orphaned chunks inflate `storage.estimate().usage` and cause
    mid-download quota refusals. Fix: trim old-version entries on activate.

22. **`activate()` purges the old shell even when the new install failed**
    — `sw.js` activate path deletes previous caches; if `install` errored mid-way the app loses
    its only offline entry point until the next successful visit. Reported.

23. **Storage meter ≠ `usedBytes` accounting; `missing` rows show phantom bytes**
    — UI meter uses `storage.estimate()` (SW caches included) while rows use recorded
    `bytesDone`; rows with `missing[]` count pieces they don't have. Reported.

24. **Settings hydration overwrites a just-changed download setting**
    — late `load()`/hydration write beats a user toggle made during startup (race). Reported.

25. **✅ FIXED — Library grid shows stale active/queued rows with live pulse but no retry path**
    — orphaned `active`/`queued` state after a crash shows animating progress forever with no
    tap-to-retry affordance (separate from the Partial repair path). Reported. Fix: stale rows
    show a static % chip with tap-to-retry and a dimmed bar (`fcb46b4`).

26. **✅ FIXED — `#EXT-X-BYTERANGE` before `#EXTINF` is dropped by the rewriter**
    — `lib/offline/hls.ts` line-order assumption; nonstandard-but-legal order loses the range →
    corrupt media. Reported. Fix: honour the tag in either order at all three parse/rewrite
    sites; mixed-order regression test (`f4b0e10`, `6342687`).

27. **`deleteRecordFiles` deletes the shared poster thumb of siblings**
    — poster files are de-duplicated across rows but deletion is per-row → other rows' artwork
    disappears. Reported.

28. **IntroDB JSON cached in the versioned shell cache** — stale intro data until VERSION bump;
    should live in an unversioned/runtime cache. Reported (`sw.js`).

29. **`staleWhileRevalidateJson` offline fallback unreachable** — `respondWith` not wired on the
    offline branch, so JSON requests fall through while offline. Reported (`sw.js`).

30. **`/api/dl` sends no `Accept-Ranges` on 200; non-GET methods → HTML 404** — fetches that
    probe range support see "no ranges"; a `POST` gets HTML (breaks strict clients). Reported.

31. **Fonts are never precached** — first offline load renders with fallback fonts (FOIT/FOUT).
    Reported.

32. **Cast is offered while offline** — the receiver fetches the URL outside this SW's scope →
    guaranteed failure. Reported.

33. **✅ FIXED — Up Next countdown ignores pause / seek-back** — auto-plays next even if the user
    paused or scrubbed back in the last seconds. Reported. Fix: players emit event positions;
    the countdown is gated on pause state and dismissed on scrub-back (`76ce50d`).

34. **Escape swallowed by a capture-phase menu cleaner** — Escape no longer dismisses Up Next or
    closes the player when a menu's capture listener stops propagation. Reported.

35. **`subSource: "stream"` offline double-draws subtitles** — stored VTT is drawn while the
    stream-CC layer is also active. Reported.

---

## Suggested fix order for the rest (deferred — ask before starting)

1. P1 #15 (`refineEstimate` unreachable → over-eviction) + #17/#18 (offline subs UX) — most
   user-visible remaining.
2. P2 #19 (source picker live offline), #25 (orphaned active rows), #26 (byterange order).
3. #5b per-row manifest storage (design first — replaces whole-manifest writes).
4. #8 only after the server can return tombstones with timestamps.

## Verified green at `7b34962` (no new regressions)

`tsc --noEmit` clean · `npm run test:offline` ok · `npm run test:player` ok ·
lint delta zero (~143 pre-existing repo-wide baseline, untouched regions only).
