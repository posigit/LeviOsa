# `components/vix-player.tsx` — decomposition log

Goal: shrink the 4,171-line god file without behavior changes. Every batch is a set of
**pure moves** (code relocated verbatim, comments travel with it), verified with:

```
npx tsc --noEmit
npx eslint .
npm run test:offline
npm run test:player
npm run build
```

then committed separately.

## Structure map (pre-refactor line ranges)

| Range | Contents |
|---:|---|
| 1–85 | imports (player libs, embed sources, overlays, transport) |
| 87–88 | `loggedRejectedOrigin` module flag |
| 90–101 | session-lock module state (mount-counted handoff) |
| 103–123 | `destroyAudioGraph()` |
| 138–151 | `EmbedHint` component |
| 152–153 | `PlayerEventPos` type |
| 155–241 | `VixPlayer` props + doc comment |
| 242–500 | state declarations (~60 `useState` hooks) |
| 501–717 | setup/reset effects incl. single mount lifecycle (666–717) |
| 718–1105 | callbacks: emit, position save/clear, seek machinery, driven-embed commands, chrome/tap, resume/restart |
| 1106–1400 | resume-lookup effect, buffering, offline auto-resume, source switching (1375+) |
| 1401–1760 | `switchSource`, `retryStream`, IMDb + OpenSubs effects/handlers |
| 1760–1942 | subtitle cascade (iframe cues, offline track inject) |
| 1942–2131 | `flushPosition`, duration/advance effects |
| 2131–2519 | fullscreen, orientation, transport actions, volume, speed, sleep |
| 2519–2833 | audio graph / boost, ambilight, gestures |
| 2833–3071 | lockscreen IPC, Cast SDK + remote |
| 3071–3485 | postMessage normalizers (CineSrc, VidAPI, PLAYER_EVENT bus) |
| 3485–3628 | keyboard shortcuts, sub delay, hide-time flush |
| 3628–3760 | derived state: error copy, `showResume`, `showTransport` |
| 3761–4171 | render JSX (shell, video, chrome, overlays) |

## Module map (what lives where)

| Extracted to | Contents |
|---|---|
| `lib/player-session-lock.ts` | session-lock module state + `readSessionLocked` / `writeSessionLocked` / `beginLockMount` / `endLockMount` |
| `lib/player-audio-graph.ts` | `destroyAudioGraph()` |
| `lib/player-source-picker.ts` | `ALL_SOURCES`, `disabledSourcesFor(type)`, `nextPlayableSource(current, disabled)` |
| `lib/player-error-copy.ts` | `StreamErrorInfo` type + `streamErrorCopy(offline, error)` |
| `components/embed-hint.tsx` | `EmbedHint` |
| `components/player-error-overlay.tsx` | error-card JSX (Retry / Close / Try-next buttons) |
| `components/player-overlays.tsx` | `UnlockButton`, `TapCue`, `LoadingPill`, `BufferingSpinner` |
| `lib/embed-sources.ts` (addition) | `warnOnceRejectedPlayerEvent()` — once-per-page rejected-origin log |
| `lib/player-cast.ts` | `useCastRemote()` hook: cast state, SDK load, poll, start/stop, `castPlayPause`/`castSeekBy`/`endCastForNewMedia`, shared remote handle |

Placement follows existing conventions: player logic in flat `lib/player-*.ts`, UI in flat
`components/*.tsx`.

## Batch log

### Batch A — module helpers + error overlay (verified ✅)
- Moved: session lock, `destroyAudioGraph`, `EmbedHint`, source-picker trio, error copy,
  error overlay JSX.
- Result: `vix-player.tsx` **4,171 → 3,927 lines (−244)**; 6 new modules (196 lines total).
- Verified green: `tsc --noEmit`, `eslint` (0 errors / 21 baseline warnings, none new),
  `test:offline`, `test:player`, `build`.
- Behavior notes:
  - `nextPlayableSource` now takes the disabled set as a parameter (was closed over
    `disabledSources`); call sites compute `nextPlayableSource(activeSource, disabledSources)`.
  - `ALL_SOURCES` is now a module constant (was recreated per render) — same array.
  - `useState(sessionLocked)` → `useState(readSessionLocked)` (lazy init, same first-read).
  - Error overlay: Close renders when `!canRetry`, Try-next when
    `streamable && !offlineOverride` — identical to the inlined JSX.

### Batch B — render overlays + rejected-origin flag (verified ✅)
- Moved: lock button, tap cue (+10/−10), loading pill, rebuffer spinner →
  `components/player-overlays.tsx`; `loggedRejectedOrigin` →
  `warnOnceRejectedPlayerEvent()` in `lib/embed-sources.ts` (next to
  `isEmbedPlayerOrigin`).
- Result: `vix-player.tsx` **3,927 → 3,900 lines (−27)**; total 4,171 → 3,900 (−271).
- Verified green: `tsc --noEmit`, `eslint` (0 errors / 21 baseline warnings),
  `test:offline`, `test:player`, `build`.
- Behavior notes:
  - Rebuffer-spinner z-index rationale comment moved into the component doc.
  - `LoaderCircle`/`Lock` lucide imports removed from `vix-player.tsx` (still used by
    the new overlays file; `SkipForward` stays).

### Batch C — cast block → `useCastRemote` hook (verified ✅)
- Moved: cast state + mirror, shared remote ref, SDK-load effect, poll control,
  `startCast`/`stopCast`/`castPlayPause`/`castSeekBy`, switchSource teardown
  (`endCastForNewMedia`), unmount cleanup → `lib/player-cast.ts` (275 lines).
- Result: `vix-player.tsx` **3,900 → 3,686 lines (−214)**; total 4,171 → 3,686 (−485).
- Verified green: `tsc --noEmit`, `eslint` (**0 errors / 16 warnings — below the 21
  baseline**), `test:offline`, `test:player`, `build`.
- Behavior notes:
  - Hook params (`videoRef`, `remotePositionRef`, `setTransport`) and the returned
    bindings are in dep arrays now — added only where the value is stable
    (ref objects, setState, `useCallback([])`), so re-run timing is unchanged.
  - `getCastRemote`/`endCastForNewMedia` are `useCallback([])` (were plain closures).
  - Unmount cleanup consolidated: hook clears poll + remote handle (was spread over
    the lifecycle effect + a standalone effect).
  - Media Session effect stays in `vix-player` — it mixes cast with driven-embed and
    native paths; it only borrows `castingRef`/`getCastRemote` from the hook.
- Incident: a PowerShell splice read the file with ANSI encoding and double-encoded
  107 em-dashes; restored from HEAD and re-applied with `-Encoding UTF8`.
  Rule: any PowerShell read of source files MUST pass `-Encoding UTF8`.

## Remaining candidates (next batches)

1. postMessage normalizers (≈3071–3485, ~415 lines) → `lib/player-embed-bus.ts` handlers;
   big refactor — the effect closes over ~30 refs/callbacks, needs a context object.
2. Resume/position machinery (718–1400) → `usePositionSaver` hook — highest care: hold/abort
   semantics documented at 1174–1250 are load-bearing.
3. Gesture handlers (2620–2713) → `useVolumeBrightnessGestures`.
