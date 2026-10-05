# Playback fix tracker

Streaming, downloads, offline playback, and subtitles. Each item is one commit.
Checked items are on `master`. Do not start the next item until the current
one is committed.

## Done

- [x] Tracker only — no behavior change yet

## Fixes, in order

- [x] **1. Resolver blip is fatal.** `isHardDownloadError` matches the word `resolver`, so `Stream resolver failed … then retry` is stored `retryable: false` and auto-resume never runs. Match the unconfigured sentence only.
- [x] **2. SRT cue text that is only a number is deleted.** `srtToVtt` drops every all-digit line. Drop cue indexes only (the digit line immediately before a timestamp).
- [x] **3. Sample encryption other than `SAMPLE-AES` is saved as clear video.** Treat any `METHOD` other than `NONE` and `AES-128`, and any non-identity `KEYFORMAT`, as unsupported.
- [x] **4. Logged-out drains delete queued progress.** 401 and 403 increment the outbox attempt cap. Leave those entries until a real success or a permanent 4xx.
- [x] **5. Byte-range 206s become status 200.** vidsrc media proxies sniff `octet-stream` / empty / `text` bodies and answer 200 with only the slice. Pass 206 through. `sliceToRange` should keep a 200 whose length is already the window.
- [x] **6. Map BYTERANGE poisons the next implicit offset.** `#EXT-X-MAP` is not a media segment. Do not advance the implicit byte cursor from it. Reset that cursor on `#EXT-X-DISCONTINUITY`.
- [x] **7. Crossing the outro or 92% latches ended.** A scrub back never saves, and the next open starts at 0. Reopen the bookmark when playback is clearly before the finish line.
- [ ] **8. Episode advance inherits the previous seek.** The player stays mounted across episodes (`key` is the show id) and the `[src]` reset does not clear `pendingSeekPosRef`.
- [ ] **9. A finished offline watch grows a Resume line back.** Sync adopts a server row after the local clear, and the later DELETE does not remove it. Tombstone the clear. When both timestamps exist, the newer bookmark wins.
- [ ] **10. Offline Auto hides stream captions, and iPhone paints both.** Prefer the captured `offline-subs` rendition. A spare pick must not write `subSource: "opensub"`. Safari must not leave the stream track and the injected track both active. Skip SubDL spare downloads when captions are off or stream-only.
- [ ] **11. A single WebVTT subtitle rendition is dropped.** Segmented caption playlists are captured. A `WEBVTT` document (no `#EXTINF`) is not, so offline falls through to an external file.

## Left for a later pass

- Same-length re-cut can splice: rendition signature is height plus segment count.
- Checkpoint writes the whole manifest, caption bodies included, once per segment.
- Three online playlist rewriters (`stream-proxy.ts`, `resolver-server/worker.js`, `resolver-server/server.js`) and a dead `rewritePlaylistForOffline`.
- `vix-player.tsx` is still the god component. Do not split it in this pass.
- Sub delay does not move captured HLS captions, only injected VTT.
