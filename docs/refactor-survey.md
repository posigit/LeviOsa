# Refactor Survey — LeviOsa (`tvtime-app`)

Line counts surveyed 2026-09-29 (excludes `node_modules`, `.next`, `public/vendor`, `data`).
Status: `pending` / `in progress` / `done` (link the commit when done).

## Tier 1 — god files (biggest wins)

| Lines | File | Problem / direction | Status |
|---:|---|---|---|
| 4,171 → 3,900 | `components/vix-player.tsx` | One `VixPlayer` function from :155 to EOF (~4,000 lines). Extract pure helpers → `lib/player-*.ts`, overlays → `components/*`, later: hooks for resume/cast/subtitles/source-cascade | in progress (Batches A+B done) → see `docs/vix-player-refactor.md` |
| 2,097 | `lib/offline/engine.ts` | Retry policy, queue pump, auto-resume timers, cache-chain, poster lookup in one module → split into 4–5 files | pending |
| 1,919 | `components/show-detail-client.tsx` | Single component from :118 (~1,790 lines) — episode rows, season rails, download buttons → separate components | pending |
| 1,496 | `app/(tabs)/profile/page.tsx` | Lists / history / stats / settings sections → own components + data loader | pending |
| 1,084 | `lib/tmdb.ts` | Split by resource (tv / movie / person / search) with shared fetch+cache | pending |
| 1,043 | `components/player-top-chrome.tsx` | Source / CC / quality / speed menus → one component each | pending |
| 1,011 | `app/movie/[id]/page.tsx` | Server page: fetch waterfall → `movie-loader.ts` | pending |

## Tier 2 — worth doing

| Lines | File | Direction | Status |
|---:|---|---|---|
| 977 | `lib/player-engine.ts` | Extract subs-loader + seek-restore | pending |
| 799 | `lib/offline/hls.ts` | Split parsing / error policy / gap-budget | pending |
| 791 | `components/player-transport.tsx` | speed / sleep / server menus → subcomponents | pending |
| 753 | `lib/offline/store.ts` | migrations vs record CRUD | pending |
| 659 | `app/(tabs)/movies/page.tsx` | decorative sparkle markup → components | pending |
| 657 | `lib/ensure.ts` | per-entity (shows / movies / episodes) | pending |
| 627 | `lib/explore-digest.ts` | build vs persist | pending |
| 589 | `lib/playback.ts` | CRUD vs heartbeat/outbox | pending |
| 506 | `public/sw.js` | precache / route handlers / API fallback into sections | pending |

## Tier 3 — folder-ify, not split

- Download cluster (~1,343 lines): `download-grid.tsx` 362 + `download-settings-sheet.tsx` 357 +
  `download-row.tsx` 314 + `download-button.tsx` 310 → shared types/queue logic live in
  `lib/downloads.ts` already; only unify what is actually duplicated.
- `lib/player-stream.ts` 422 / `lib/vix-settings.ts` 472 — cohesive, leave alone.

## Not worth touching

`skeletons.tsx` (606, static), `globals.css` (582, structured), `schema.ts` (367, data model),
`scripts/test-offline-download.ts` (558, test), `components/ui/**` (shadcn vendored).

## Rules

- One logical change per commit; `npx tsc --noEmit` + `npx eslint .` + relevant test suite +
  `npm run build` green before every commit.
- Pure moves only in extraction batches — no behavior changes, comments travel with the code
  they explain.
- Never push without an explicit "PUSH".
