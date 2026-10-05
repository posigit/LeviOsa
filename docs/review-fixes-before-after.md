# Review fixes — what was intended, what happened, what we expect now

Read-only review of `620d8af..474c269` (17 commits) found seven defects, and a
second pass over the fixes themselves found three more. This records, for each
one, why the original change was made, the behaviour the code actually produced,
and the behaviour expected after the fix.

Eleven commits: `5304f61` → `9ebafbd`. The first seven are the reviewed defects;
`cff6625`, `ecac8ad` and `9ebafbd` came out of reviewing those fixes.

---

## 1. `fix(subs): paint Stream cues on a clock embed` — `5304f61`

**Source commit:** `1cebf8a` *(follow Auto when a clock embed is set to Stream)*

**Intended.** CineSrc and VidFast frames have no caption track of their own. A
saved **Stream** choice should follow the Auto cascade on that surface so the
overlay fills and the Auto row checks, while the stored setting stays Stream for
a native player.

**What actually happened.** Half the change. The fetch derived the source
(`clockEmbedSubSource(subSource)`, `vix-player.tsx:1980`) but the render gate
still read the raw setting (`subSource !== "stream"`, `:4169`).

- cues were fetched and parsed into `iframeCues`
- `IframeSubtitleOverlay` has exactly one mount site and is the only consumer
  of `iframeCues`

So the fetch succeeded, the CC menu checked **Auto**, and nothing painted.

**Expected now.** One derived source drives both ends. A saved Stream on a clock
embed loads *and* shows captions; `off` still hides them.

---

## 2. `fix(subs): keep a saved-alt pick enabled on Safari` — `eaed746`

**Source commit:** `87046e2` *(offline subtitle selection precedence)*

**Intended.** Picking one of the subtitle files stored with a download should
turn subtitles on **for this title only**, without changing the global picker
(that used to make the next online title fetch OpenSubtitles).

**What actually happened.** Two gates both still read "off":

1. `applyNative` captured `const s = loadVixSettings()` **outside** its body
   (`player-engine.ts:643`, function at `:645`), so `s.subs` was frozen at
   attach time. The path writes `subs: "en"` to storage, which the snapshot never
   sees. The hls path self-heals at `:234-236`; the native path has no equivalent.
2. The effect that mirrors `subSource` into `subSourceRef` only fires when
   `subSource` changes — and this path deliberately does not touch it.

The `addtrack → queueMicrotask(applyNative)` pass added by that commit then hit
`:662` (`s.subs === "off" || subSourceRef.current === "off"`) and ran
`exclusiveTextTracks(video, [])`, disabling the track the inject had just
landed. Fixing only the first operand would not have helped — the OR still fired.

**Expected now.** `applyNative` re-reads settings on every pass (`:645`), and
`handleSavedSubAltPick` refreshes `subSourceRef` for this mount only when it
says `off`. The picked track stays enabled. Menu rows and the persisted picker
are untouched. The same re-read fixes the language gate at `:670`, which was
frozen for the whole attach session.

---

## 3. `fix(offline): treat a failed video sample as unknown, not a re-cut` — `daf77ac`

**Source commit:** `e8bc548` *(wipe video when a same-length re-cut changes the bytes)*

**Intended.** A re-encode can keep height *and* segment count, so sample three
16 bytes heads (init, segment 0, middle) and compare against the stored
fingerprint. `"A failed sample does not wipe."` — the call site says so.

**What actually happened.** The `null` guards were inside `if (fromCache)`:

- segment 0 fails → `videoCutFingerprint` returns `null` → safe, no wipe
- init or middle fails → `headHex(null)` → `"-"`, segment 0 still fine → non-null
  fingerprint → `videoCutMismatch` sees a difference → **wipe**

A remote head that 404s or times out is indistinguishable from a legitimately
absent init map, and `videoCutMismatch` only does string inequality.

Cost of one flaky range request: wipe + full re-download, then the next attempt
samples the real bytes back, mismatches the poisoned stored value, and wipes
**again**. Two full re-downloads per failure. No counter bounds this —
`autoAttempts` resets on success and wipes don't consume it.

**Expected now.** A missing head on *either* path returns `null` → no
fingerprint → no wipe. The three guards are shared, which is what both comments
already claimed. `"-"` now only ever means "this playlist has no init map",
which is stable across attempts.

---

## 4. `fix(offline): store the video fingerprint with the bytes it describes` — `986bebd`

**Source commit:** `e8bc548` (same commit as #3)

**Intended.** Persist the new fingerprint so the next attempt compares against
what is actually stored.

**What actually happened.** It was persisted *before* quota and *before* the
delete (`rec.videoFingerprint = nextFp` at `:2038`/`:2043`, `upsertRecord` at
`:2161`). Three normal-production paths throw in that window while the old bytes
are still on disk:

| Line | Throw |
|---|---|
| `:2071` | playlist shrunk — *"kept stored bytes; will retry"* |
| `:2115` | reverify unstable — *"kept stored bytes"* |
| `:2165` | `enforceQuota` refusal — *"needs ~X, free space"* |

The record then claims a fingerprint the disk does not hold, and it persists
(the error path spreads `{ ...rec }`). Every later attempt sees no change and
skips the guard **forever** — the exact corruption the commit exists to prevent.

Second defect, same root: a legitimate re-cut that wiped through
`planRenditionWipe` never updated the fingerprint either, so the next attempt
wiped the freshly downloaded video a second time.

**Expected now.** The fingerprint is assigned only after the wipe, only when
video was actually wiped, and carries `undefined` when no sample was taken —
"unknown" never wipes. Sampling also runs whenever video bytes exist, not only
when the rendition signature came back clean, so the value always describes the
bytes on disk. See §8 for the half of this that only surfaced once the fix was
reviewed: writing the value was pointless unless a later run read it.

---

## 5. `fix(offline): reset the pending fingerprint for each mirror attempt` — `d6e31e3`

**Source commit:** `e8bc548` (same commit as #3/#4)

**Intended.** `pendingCutFingerprint` is written onto the record only once the
attempt's bytes match it (committed on `state: "done"`).

**What actually happened.** It is declared once per **run** (`:1892`) and never
cleared, while `downloadAttempt` runs once per **mirror** (`:2499` in the loop at
`:2472`). A sample from the mirror that failed survived into the next attempt and
was committed when a different mirror landed — storing a fingerprint for bytes
that were never on disk, which the next resume calls a re-cut.

**Expected now.** Reset at the top of each attempt, so the fingerprint always
comes from the attempt that actually landed.

---

## 6. `fix(offline): sign subtitle bodies by content, not by length` — `d61d2fa`

**Source commit:** `368ba78` *(stop checkpointing subtitle text on every segment)*

**Intended.** Skip rewriting the subtitle blob in IndexedDB when nothing
changed — progress writes should stay small.

**What actually happened.** `bodiesSig` was `${keys.length}:${totalCharacters}`.
A rewrite that kept the byte count was treated as unchanged: the in-memory record
carried the new text, the disk copy kept the old one, and the captions no longer
matched the file.

**Expected now.** Every key, label and body is folded into a hash. Bodies are
cached by string so the common no-change write stays a handful of lookups rather
than a full re-read of every caption on every progress checkpoint, and the cache
is capped because bodies are rewritten per download.

---

## 7. `fix(offline): compare bookmarks in one clock` — `f76078e`

**Source commit:** `5423256` *(tombstone a cleared resume position)*

**Intended.** A local clear must not be undone by a server bookmark the DELETE
hadn't caught up with yet; when both sides have a time, the newer bookmark wins.

**What actually happened.** Two clocks were compared as if they were one:

- `serverAt` — the database's `updatedAt`
- `clearedAt` / `local.at` — `Date.now()` on this device

Skew decided the outcome. A server clock running ahead could resurrect a bookmark
this device had just cleared, with a row that was actually *older* than the
clear; a lagging server could never contribute at all. The tombstone map also
only ever grew, and was `JSON.parse`d on every position write and every merge.

**Expected now.** The response's own `Date` header is the server clock at reply
time; the gap is measured once and every row is shifted into this device's clock
before comparison. No header → no shift → previous behaviour. Tombstones are
pruned after a successful sync for keys absent from the full server list — a key
that is not there has no row to copy back, so nothing can resurrect it.

---

## 8. `fix(offline): read the stored video fingerprint back` — `cff6625`

**Source commit:** `e8bc548` (the same commit as #3/#4/#5)

**Intended.** The comment on the write says *"so the next attempt compares
against what's actually stored."*

**What actually happened.** Nothing ever stored it back into the record a run
starts from. `startDownloadInner` builds its record from a literal
(`engine.ts:615-665`) that copies `rendition` and `usedPlaylistUrl` from
`existing` but not `videoFingerprint`, and `runDownload` is reached from exactly
one place — that literal. So `rec.videoFingerprint` was `undefined` at the top of
every single run:

- `videoCutMismatch(undefined, sampledFp)` is always `false`
- the guard fell through to the `else if (!rec.videoFingerprint)` branch every time
- the disk-vs-remote sample did the whole job, as it had before the field existed

Fix #4 therefore put a value on the record that was written on every run and read
on none — a field with a write side and no read side.

**Expected now.** The fingerprint travels with the record on a same-quality
restart (and is dropped with everything else on a quality switch, matching
`rendition`). The comparison prefers the bytes actually on disk, because that is
what plays, and falls back to the stored value only when a partial download has
not cached the middle segment and looking is impossible.

Reading the disk first is the part that matters: the stored value is a *claim*
about bytes we have not looked at. Seeding it without the disk check would have
made a wrong claim (a record written during the window #4 fixed) authoritative
and produced a wipe the disk itself did not justify.

---

## 9. `fix(subs): paint a saved file when the picker is Off` — `ecac8ad`

**Source commit:** `87046e2`, reached through fix #2

**Intended.** Fix #2 makes a saved-alt pick enable the track by writing
`subSourceRef.current = "auto"`, deliberately leaving `subSource` state and the
persisted picker alone (the menu should keep showing the user's global choice).

**What actually happened.** The track was enabled and nothing painted. The
`SubtitleOverlay` gate read the picker *state*:

```
enabled={subSource !== "off"}        // vix-player.tsx:4164
```

With the picker at Off that stays `false`, the effect early-returns and clears
the cue text, and the render returns `null` — so the fix produced a live text
track that no overlay was reading. `["off", "Off"]` is a real menu row
(`player-top-chrome.tsx:536`, `:544`), so this is reachable, not theoretical.

**Expected now.** The overlay turns on when a saved file is active for this
title, alongside the picker state. Picking a stored file with subtitles at Off
paints; picking **Off** again still clears `savedSubAltPick` and the inject
effect drops the track, so there is no text to paint and nothing shows.

---

## 10. `fix(offline): bound the body hash cache and guard the tombstone write` — `9ebafbd`

**Source commit:** `368ba78`, reached through fix #6, and `5423256` through fix #7

**What actually happened.** Two things the fixes introduced:

1. **The cache was fed short strings.** `bodiesSig` folds every key, label and
   body through one 512-entry `Map`. Keys and labels are a handful of characters
   and cost less to hash than a map probe, but they counted against the same cap
   as the multi-kilobyte caption bodies the cache exists for — so a manifest with
   enough files could thrash, clearing the cache wholesale and re-reading every
   stored caption on the next progress write. Exactly the cost fix #6 was
   avoiding.
2. **The tombstone prune was unguarded.** The new `localStorage.setItem` in
   `syncOfflinePositions` (`store.ts:855`) sat outside any `try`/`catch`, while
   every other write in the file has one. `setItem` throws on a full or frozen
   storage, and this one runs before the merge loop — so a housekeeping failure
   would have taken the entire resume sync down with it.

**Expected now.** Strings under 64 characters are hashed directly and never
enter the cache, leaving it to bodies where it pays for itself. The prune write
is wrapped like its neighbours; if storage refuses, the map stays oversized until
the next sync and the merge loop still runs.

---



- **`db20192` (MAP byte-range).** The change matches strict RFC 8216 §4.3.2.2:
  `EXT-X-MAP` is not a media segment, so resetting the byte offset at it is
  correct. Only a packager that emits a MAP without its own range would have
  relied on the old implicit carry-over. Worth one empirical check against a real
  byte-range master and hls.js's `prevOffset` — not a code change.
- **`f0e03fd` (outbox 401/403).** Rows that will never succeed stay in the outbox
  by design so they can be inspected; `slice(-200)` bounds growth. Intended
  tradeoff, noted rather than fixed.

## Cosmetic, not fixed

- `lib/player-subs.ts` — JSDoc above `streamCueVisible` describes an earlier
  helper that no longer exists.
- `components/player-top-chrome.tsx:568-583` — the clock-embed "Stream reads as
  Auto" check is written twice, once for the highlight and once for the tick.

## Deliberately not added

No wipe counters, hysteresis, retry budgets or other restart hardening. The
restarts came from these defects; with them fixed the existing guards
(`isShrunkParse`, reverify-before-wipe, quota-before-wipe, source pinning) are
sufficient, and the failure modes above are now unreachable rather than merely
rate-limited.

## Known limitations — examined, accepted

- **The tombstone map is account-blind.** Pruning keeps only keys present in the
  server list, with no account dimension. Two accounts on one device could drop
  each other's tombstones. The original code was account-blind in the other
  direction (it never pruned at all), so this is not a regression; adding the
  dimension needs a per-account clear map, which is a schema change.
- **A residual within-run fingerprint window.** `pendingCutFingerprint` is reset
  per attempt (#5), but if mirror A fails after sampling and mirror B lands
  *without* setting its own sample, the pending value from A can be committed.
  The code only reaches that assignment when the sample matched the bytes on
  disk, so it is self-healing and no worse than the pre-fix behaviour, which was
  wrong in the same place without ever correcting itself.
- **`Date` headers have one-second granularity** and a proxy may rewrite one. The
  skew correction is therefore accurate to about a second plus transit, where the
  comparison it replaces was wrong by however far the two clocks had drifted —
  routinely minutes. An inherent property of using the header as the clock, not a
  bug in the implementation.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `scripts/test-player-progress.ts` | pass |
| `scripts/test-offline-download.ts` | pass |
| `scripts/test-player-surfaces.tsx` | pass |
| `scripts/test-cc-gate.tsx` | pass |
| `scripts/test-subdl.ts` | **external API flake** |

`test-subdl` hit `404 {"error":"no subtitles found"}` from the live SubDL API on
three consecutive runs after an earlier pass in the same session, failing at a
different lookup each time. Its import graph is
`test-subdl → app/api/subdl/route → lib/player-subs`, and none of those are in
the four files these commits touch — the failure is independent of this change.
