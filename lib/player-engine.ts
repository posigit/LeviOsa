/**
 * Native HLS engine (hls.js + Safari native HLS).
 * Attaches to a <video>, applies settings, loads external subs, restores
 * pending seek position (source switch OR cold resume) after the stream is
 * ready — critical for Vix resolver multi-hop playlists.
 */
"use client";

import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import Hls from "hls.js";
import {
  loadVixSettings,
  saveVixSettings,
  matchLang,
} from "@/lib/vix-settings";
import { RESUME_MIN_SECONDS } from "@/lib/player-constants";
import { seekVideoElement } from "@/lib/player-seek";
import {
  demoteShowingTracks,
  fetchExternalVtt,
  injectVttTrack,
  type SubSource,
} from "@/lib/player-subs";
import type {
  AudioTrackInfo,
  NativeAudioTrackList,
  QualityLevelInfo,
} from "@/lib/player-native-types";

export type AttachNativePlaybackArgs = {
  video: HTMLVideoElement;
  playlistUrl: string;
  type?: "movie" | "tv";
  tmdbId?: number;
  season?: number;
  episode?: number;
  imdbIdRef: MutableRefObject<string | null>;
  /**
   * Pending seek for source-switch OR cold resume. Engine seeks after
   * MANIFEST_PARSED / FRAG_LOADED (and prefers hls.js startPosition).
   */
  pendingSeekPosRef: MutableRefObject<number | null>;
  subSourceRef: MutableRefObject<SubSource>;
  injectedTracksRef: MutableRefObject<TextTrack[]>;
  externalVttRef: MutableRefObject<{ vtt: string; label: string } | null>;
  reloadSubsRef: MutableRefObject<(() => void) | null>;
  reapplyExternalSubsRef: MutableRefObject<(() => void) | null>;
  safariTimerRef: MutableRefObject<number | null>;
  setHlsAudioTrackRef: MutableRefObject<((id: number) => void) | null>;
  setHlsQualityRef: MutableRefObject<((next: "auto" | number) => void) | null>;
  /**
   * Effective rendition reporter (ABR transparency): called with the current
   * level height on every LEVEL_SWITCHED (hls.js) or video resize (Safari
   * native), null when unknown. Never persisted — the saved pin stays the
   * source of truth for what to play.
   */
  setEffectiveQualityRef: MutableRefObject<((h: number | null) => void) | null>;
  setAudioTracks: Dispatch<SetStateAction<AudioTrackInfo[]>>;
  setAudioTrackId: Dispatch<SetStateAction<number>>;
  setQualityLevels: Dispatch<SetStateAction<QualityLevelInfo[]>>;
  setQualitySelection: Dispatch<SetStateAction<"auto" | number>>;
  setHasExternalSubs: Dispatch<SetStateAction<boolean>>;
  setStreamFailed: Dispatch<SetStateAction<boolean>>;
  savePosition: (pos: number, duration: number, force?: boolean) => void;
  revertExternalSub: (failed: "vdrk" | "opensub") => void;
  /**
   * Offline playback with a stored subtitle track already injected by the
   * host: skip all network subtitle cascades and never wipe injected tracks
   * ( reload becomes applySettings-only ). Overlay visibility still follows
   * subSource state.
   */
  offlineStoredSubs?: boolean;
  /**
   * Download key when playing from cache — enables hole recovery (a fatal
   * on local bytes means an evicted/gapped segment, not a dead stream).
   */
  offlineKey?: string | null;
  /** Fired once when pending seek lands (or is abandoned). */
  onPendingSeekSettled?: (result: { pos: number; ok: boolean }) => void;
};

function readPendingSeek(
  ref: MutableRefObject<number | null>
): number | null {
  const pos = ref.current;
  if (pos == null || !Number.isFinite(pos) || pos <= RESUME_MIN_SECONDS) {
    return null;
  }
  return pos;
}

export function attachNativePlayback(args: AttachNativePlaybackArgs): () => void {
  const {
    video,
    playlistUrl,
    type,
    tmdbId,
    season,
    episode,
    imdbIdRef,
    pendingSeekPosRef,
    subSourceRef,
    injectedTracksRef,
    externalVttRef,
    reloadSubsRef,
    reapplyExternalSubsRef,
    safariTimerRef,
    setHlsAudioTrackRef,
    setHlsQualityRef,
    setEffectiveQualityRef,
    setAudioTracks,
    setAudioTrackId,
    setQualityLevels,
    setQualitySelection,
    setHasExternalSubs,
    setStreamFailed,
    savePosition,
    revertExternalSub,
    offlineStoredSubs = false,
    offlineKey = null,
    onPendingSeekSettled,
  } = args;

    let hls: Hls | null = null;
    /** Fatal-error recoveries (network startLoad / media recover). Capped so
     * a dead stream can't loop forever behind a "Loading…" spinner. */
    let fatalErrorCount = 0;
    const MAX_FATAL_ERRORS = 3;
    /** Offline hole hops before giving up (see the offline branch in ERROR). */
    let offlineRecoveries = 0;
    const MAX_OFFLINE_RECOVERIES = 6;
    const OFFLINE_HOP_SECONDS = 15;
    const cleanup: Array<() => void> = [];
    let bootstrapTimer: number | null = null;
    let pendingSeekTimer: number | null = null;
    let pendingSeekSettled = false;

    const notifySeekSettled = (pos: number, ok: boolean) => {
      if (pendingSeekSettled) return;
      pendingSeekSettled = true;
      if (pendingSeekPosRef.current === pos) {
        pendingSeekPosRef.current = null;
      }
      onPendingSeekSettled?.({ pos, ok });
    };

    // Snapshot at attach — used for hls.js startPosition (Vix resolver cold resume).
    const startPos = readPendingSeek(pendingSeekPosRef);

    if (Hls.isSupported()) {
      // startPosition: load near bookmark instead of 0-then-seek (Vix multi-hop).
      hls = new Hls(
        startPos != null
          ? { startPosition: startPos }
          : undefined
      );
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);

      // hls.js populates audio/subtitle tracks AFTER MANIFEST_PARSED (lazy).
      // So: try on every track-population event, but only until the user
      // makes a live choice (userTouched) so we never stomp their selection.
      let userTouched = false;
      let everApplied = false;
      let applying = false;
      let bootstrapDone = false;
      /** Apply volume/mute once — re-applying muted:true after user unmute was killing audio. */
      let avPrimed = false;
      bootstrapTimer = window.setTimeout(() => {
        bootstrapDone = true;
      }, 2500);

      const syncAudioMenu = () => {
        if (!hls) return;
        setAudioTracks(
          hls.audioTracks.map((t) => ({
            id: t.id,
            lang: t.lang || "",
            name: t.name || t.lang || `Audio ${t.id}`,
          }))
        );
        setAudioTrackId(hls.audioTrack);
      };

      const syncQualityMenu = () => {
        if (!hls) return;
        const seen = new Set<number>();
        const levels: { height: number; index: number }[] = [];
        hls.levels.forEach((lv, index) => {
          const h = lv.height || 0;
          if (h > 0 && !seen.has(h)) {
            seen.add(h);
            levels.push({ height: h, index });
          }
        });
        levels.sort((a, b) => b.height - a.height);
        setQualityLevels(levels);
      };

      setHlsAudioTrackRef.current = (id: number) => {
        if (!hls) return;
        applying = true;
        userTouched = true;
        hls.audioTrack = id;
        applying = false;
        const t = hls.audioTracks.find((x) => x.id === id);
        if (t?.lang) saveVixSettings({ audio: t.lang });
        setAudioTrackId(id);
      };

      setHlsQualityRef.current = (next: "auto" | number) => {
        if (!hls) return;
        applying = true;
        if (next === "auto") {
          hls.currentLevel = -1;
          hls.loadLevel = -1;
        } else {
          const li = hls.levels.findIndex((lv) => lv.height === next);
          if (li >= 0) {
            hls.currentLevel = li;
            hls.loadLevel = li;
          }
        }
        applying = false;
        setQualitySelection(next);
        saveVixSettings({ quality: next });
      };

      const applySettings = () => {
        if (!hls) return;
        const s = loadVixSettings();
        // Keep Auto/source prefs from being stuck on poisoned subs:"off".
        if (subSourceRef.current !== "off" && s.subs === "off") {
          saveVixSettings({ subs: "en" });
          s.subs = "en";
        }

        const at = hls.audioTracks.find((t) => matchLang(t.lang, s.audio));
        if (at && hls.audioTrack !== at.id) {
          applying = true;
          hls.audioTrack = at.id;
          applying = false;
        }

        hls.subtitleDisplay = false; // we render via SubtitleOverlay, not native ::cue
        // Forced external modes (vdrk/opensub) own the subtitle surface: never
        // re-enable the stream's CC track here — the injected track is the one.
        const forcedExternal = subSourceRef.current === "vdrk" || subSourceRef.current === "opensub";
        const externalActive = injectedTracksRef.current.some(
          (t) => t.mode !== "disabled"
        );
        if (forcedExternal || (subSourceRef.current === "auto" && externalActive)) {
          if (hls.subtitleTrack !== -1) {
            applying = true;
            hls.subtitleTrack = -1;
            applying = false;
          }
        } else if (s.subs === "off" || subSourceRef.current === "off") {
          if (hls.subtitleTrack !== -1) {
            applying = true;
            hls.subtitleTrack = -1;
            applying = false;
          }
        } else {
          const st = hls.subtitleTracks.find((t) =>
            matchLang(t.lang, s.subs)
          );
          if (st) {
            if (hls.subtitleTrack !== st.id) {
              applying = true;
              hls.subtitleTrack = st.id;
              applying = false;
            }
          } else if (hls.subtitleTrack !== -1) {
            applying = true;
            hls.subtitleTrack = -1;
            applying = false;
          }
        }
        // Keep tracks "hidden" so cues fire without native double-draw.
        demoteShowingTracks(video);

        if (s.quality === "auto") {
          if (hls.currentLevel !== -1) {
            applying = true;
            hls.currentLevel = -1;
            hls.loadLevel = -1;
            applying = false;
          }
          setQualitySelection("auto");
        } else if (typeof s.quality === "number") {
          const li = hls.levels.findIndex((lv) => lv.height === s.quality);
          if (li >= 0 && hls.currentLevel !== li) {
            applying = true;
            hls.currentLevel = li;
            hls.loadLevel = li;
            applying = false;
          }
          setQualitySelection(s.quality);
        }

        video.playbackRate = s.speed;
        // Volume once; always start unmuted (mute is session-only, never restored).
        if (!avPrimed) {
          video.volume = s.volume;
          video.muted = false;
          avPrimed = true;
        }
        // Only counts as "applied" once subtitle tracks exist — audio-only
        // must not open the door for SUBTITLE_TRACK_SWITCH poison.
        if (hls.subtitleTracks.length > 0) {
          everApplied = true;
        }
        syncAudioMenu();
        syncQualityMenu();
      };

      let restoreArmed = false;
      const restorePendingPos = () => {
        const pos = readPendingSeek(pendingSeekPosRef);
        if (pos == null || pendingSeekSettled) return;
        // Already near target (startPosition or prior seek stuck).
        if (
          Number.isFinite(video.currentTime) &&
          Math.abs(video.currentTime - pos) <= 2.5
        ) {
          notifySeekSettled(pos, true);
          return;
        }
        // Abort if the pending target is dropped (manual scrub) or replaced
        // (source switch) — the retry loop must not snap playback back.
        void seekVideoElement(video, pos, {
          play: true,
          shouldAbort: () => readPendingSeek(pendingSeekPosRef) !== pos,
        }).then((ok) => {
          if (ok) notifySeekSettled(pos, true);
        });
        if (!restoreArmed) {
          restoreArmed = true;
          // Fail-safe: settle after 15s even if Vix resolver is slow.
          pendingSeekTimer = window.setTimeout(() => {
            const still = readPendingSeek(pendingSeekPosRef);
            if (still == null || pendingSeekSettled) return;
            const near =
              Number.isFinite(video.currentTime) &&
              Math.abs(video.currentTime - still) <= 2.5;
            notifySeekSettled(still, near);
          }, 15_000);
        }
      };

      // First attempt at manifest parse (usually empty — harmless), then
      // re-apply whenever the track lists actually populate.
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applySettings();
        restorePendingPos();
        // Always schedule Auto cascade — Vix with zero CC never fires
        // SUBTITLE_TRACKS_UPDATED (same gap Goated had).
        window.setTimeout(() => void maybeLoadFallbackSubtitles(), 1200);
      });
      // Second chance after first fragment — Vix resolver often needs this.
      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (readPendingSeek(pendingSeekPosRef) != null) restorePendingPos();
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (!userTouched) applySettings();
        else syncAudioMenu();
      });

      // Fallback subtitles — Tier 1: goated VDRK open VTT built directly from
      // tmdbId (no API call, no PoW, CORS-open). Tier 3: OpenSubtitles.
      // Respects the user's subSource preference:
      //   auto   = stream CC when present, else VDRK → OpenSubtitles
      //   stream = stream's own English CC only (never inject)
      //   vdrk   = force VDRK, even if stream has CC
      //   opensub= force OpenSubtitles
      //   off    = never
      let osLoaded = false;
      let osLoading = false;
      const maybeLoadFallbackSubtitles = async () => {
        // Offline with stored subs: the host already injected the track —
        // never fetch, never wipe, never revert (all three would strand us).
        if (offlineStoredSubs) return;
        if (osLoaded || osLoading || !hls) return;
        const src = subSourceRef.current;
        if (src === "off" || src === "stream") return; // handled by applySettings
        const engTrack = hls.subtitleTracks.find((t) => matchLang(t.lang, "en"));
        const engSelected =
          !!engTrack && hls.subtitleTrack === engTrack.id;
        // In auto mode, prefer stream English CC only when it is selected.
        if (src === "auto" && engSelected) {
          osLoaded = true;
          return;
        }
        // Listed but not selected yet — select it for cue data (overlay draws).
        if (src === "auto" && engTrack && loadVixSettings().subs !== "off") {
          applying = true;
          hls.subtitleDisplay = false;
          hls.subtitleTrack = engTrack.id;
          applying = false;
          demoteShowingTracks(video);
          osLoaded = true;
          return;
        }
        // Forced external mode on a CC-bearing stream: disable the stream's own
        // CC so the injected VDRK/OS track is the ONLY one (no double subs).
        if ((src === "vdrk" || src === "opensub") && engTrack) {
          applying = true;
          hls.subtitleDisplay = false;
          hls.subtitleTrack = -1;
          applying = false;
        }
        osLoading = true;

        const delay = loadVixSettings().subDelaySeconds;
        // Tier 1 — VDRK direct, or Tier 3 — OpenSubtitles.
        // Auto on both Vix and Goated: stream CC (handled above) → VDRK → OS.
        const wantVdrk = src === "vdrk" || src === "auto";
        const wantOs = src === "opensub" || src === "auto";
        try {
          if (wantVdrk || wantOs) {
            const source = wantVdrk ? "vdrk" : "opensub";
            const ext = await fetchExternalVtt({
              source,
              type,
              tmdbId,
              season,
              episode,
              imdbId: imdbIdRef.current,
            });
            if (ext) {
              const show = loadVixSettings().subs !== "off";
              externalVttRef.current = { vtt: ext.vtt, label: ext.label };
              setHasExternalSubs(true);
              const tr = injectVttTrack(video, ext.vtt, ext.label, show, delay);
              if (tr) injectedTracksRef.current.push(tr);
              osLoaded = true;
              return;
            }
            // Forced external source failed (dead API key / empty result):
            // don't strand the picker on it — revert to Auto so stream CC (if
            // present) keeps working and the user sees WHY.
            if (src === "vdrk" || src === "opensub") {
              revertExternalSub(src);
              return;
            }
            // VDRK failed/empty → fall through to OpenSubtitles in auto mode.
            if (wantVdrk && src === "auto") {
              const os = await fetchExternalVtt({
                source: "opensub",
                type,
                tmdbId,
                season,
                episode,
                imdbId: imdbIdRef.current,
              });
              if (os) {
                const show = loadVixSettings().subs !== "off";
                externalVttRef.current = { vtt: os.vtt, label: os.label };
                setHasExternalSubs(true);
                const tr = injectVttTrack(video, os.vtt, os.label, show, delay);
                if (tr) injectedTracksRef.current.push(tr);
                osLoaded = true;
                return;
              }
            }
          }
        } finally {
          osLoading = false;
          // Only latch "done" on success; leave retryable on total miss.
        }
      };

      // Expose a re-run hook so the picker can force a source without remount.
      reloadSubsRef.current = () => {
        // Offline with stored subs: keep the mounted track, only re-apply
        // audio/quality (which work offline). Overlay visibility follows
        // subSource state, so "off" still hides.
        if (offlineStoredSubs) {
          applySettings();
          return;
        }
        osLoaded = false;
        osLoading = false;
        externalVttRef.current = null;
        setHasExternalSubs(false);
        const src = subSourceRef.current;
        // Hide any previously injected external tracks.
        for (const t of injectedTracksRef.current) t.mode = "disabled";
        injectedTracksRef.current = [];
        if (src === "vdrk" || src === "opensub") {
          // Forced external source: kill the stream's own CC track so only the
          // injected VDRK/OS track shows (no double subtitles).
          if (hls) {
            applying = true;
            hls.subtitleDisplay = false;
            hls.subtitleTrack = -1;
            applying = false;
          }
        }
        // Re-apply persisted subs (handles off / stream-C C cases).
        applySettings();
        void maybeLoadFallbackSubtitles();
      };

      reapplyExternalSubsRef.current = () => {
        const cached = externalVttRef.current;
        if (!cached) return;
        for (const t of injectedTracksRef.current) t.mode = "disabled";
        injectedTracksRef.current = [];
        const delay = loadVixSettings().subDelaySeconds;
        const show = loadVixSettings().subs !== "off";
        // Disable stream CC while showing timed external track.
        if (hls) {
          applying = true;
          hls.subtitleDisplay = false;
          hls.subtitleTrack = -1;
          applying = false;
        }
        const tr = injectVttTrack(
          video,
          cached.vtt,
          cached.label,
          show,
          delay
        );
        if (tr) injectedTracksRef.current.push(tr);
      };

      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        if (!userTouched) applySettings();
        void maybeLoadFallbackSubtitles();
      });

      // Persist user changes (and ignore switches caused by our own apply
      // or hls.js internals during initial load).
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_evt, data) => {
        if (applying) return;
        if (!hls || hls.audioTracks.length === 0) return;
        userTouched = true;
        const t = hls.audioTracks.find((x) => x.id === data.id);
        saveVixSettings({ audio: t?.lang || "en" });
        setAudioTrackId(data.id);
      });
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_evt, data) => {
        // hls.js may flip the track to "showing"; demote so overlay owns paint.
        demoteShowingTracks(video);
        // Ignore bootstrap / internal clears — they were poisoning subs:"off"
        // while the picker still showed Auto.
        if (applying || !everApplied || !bootstrapDone) return;
        if (data.id === -1) {
          if (subSourceRef.current !== "off") return;
        }
        userTouched = true;
        const t = hls?.subtitleTracks.find((x) => x.id === data.id);
        if (subSourceRef.current === "auto" && !t) return;
        saveVixSettings({ subs: t ? t.lang : "off" });
      });
      const onTextTrackChange = () => demoteShowingTracks(video);
      video.textTracks.addEventListener("change", onTextTrackChange);
      cleanup.push(() =>
        video.textTracks.removeEventListener("change", onTextTrackChange)
      );
      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        // Don't persist ABR hops while Auto is selected — that used to turn
        // Auto into a sticky fixed height after the first switch.
        if (applying) return;
        // Always report the effective rendition (powers the "Auto · 720p"
        // pill) — reporting is read-only, never persisted.
        const lv = hls?.levels[data.level];
        if (lv?.height) setEffectiveQualityRef.current?.(lv.height);
        if (loadVixSettings().quality === "auto") return;
        if (lv?.height) setQualitySelection(lv.height);
      });
      hls.on(Hls.Events.MANIFEST_LOADED, () => {
        syncQualityMenu();
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        // Offline hole recovery: the SW serves local bytes, so a fatal here
        // almost always means one evicted/gapped segment — not a dead
        // stream. Unmounting (streamFailed → error card) would kill a
        // mostly-fine download over one hole, so hop past it and reload
        // instead. Bail only after repeated failures so a truly wrecked
        // file still surfaces the error instead of looping forever.
        if (offlineKey) {
          if (offlineRecoveries >= MAX_OFFLINE_RECOVERIES) {
            if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
              savePosition(video.currentTime, video.duration, true);
            }
            setStreamFailed(true);
            return;
          }
          offlineRecoveries += 1;
          const pos = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          if (pos > 0) savePosition(pos, video.duration, true);
          const wasPlaying = !video.paused && !video.ended;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // Hole in the buffer (404 from the SW): jump past it so the
            // next fragment request lands on a stored index.
            const dur = Number.isFinite(video.duration) ? video.duration : pos;
            const hop = Math.min(pos + OFFLINE_HOP_SECONDS, Math.max(0, dur - 1));
            if (hop > pos) {
              try {
                video.currentTime = hop;
              } catch {
                /* metadata not seekable yet — startLoad retries where we are */
              }
            }
            hls?.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls?.recoverMediaError();
          } else {
            hls?.startLoad();
          }
          if (wasPlaying) {
            window.setTimeout(() => {
              if (video.paused && !video.ended) void video.play().catch(() => {});
            }, 300);
          }
          return;
        }
        // Cap recoveries: an endlessly retrying loader looks like a frozen
        // player ("Loading…" forever). After 3 fatal errors, bail to the
        // streamFailed/iframe path so the user can act (or the cascade tries
        // the next source on a remount).
        if (fatalErrorCount >= MAX_FATAL_ERRORS) {
          if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
            savePosition(video.currentTime, video.duration, true);
          }
          setStreamFailed(true);
          return;
        }
        fatalErrorCount += 1;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
        } else {
          if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
            savePosition(video.currentTime, video.duration, true);
          }
          setStreamFailed(true);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari / native HLS: persist + restore via the native track lists.
      video.src = playlistUrl;

      const s = loadVixSettings();
      let avPrimed = false;
      const applyNative = () => {
        const at = (video as unknown as { audioTracks?: NativeAudioTrackList })
          .audioTracks;
        if (at && at.length) {
          let any = false;
          for (let i = 0; i < at.length; i++) {
            const want = matchLang(at[i].language, s.audio);
            at[i].enabled = want;
            if (want) any = true;
          }
          if (!any) at[0].enabled = true;
        }
        const tt = video.textTracks as unknown as TextTrackList | undefined;
        if (tt && tt.length) {
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i];
            if (t.kind === "subtitles" || t.kind === "captions") {
              t.mode =
                s.subs !== "off" && matchLang(t.language, s.subs)
                  ? "hidden"
                  : "disabled";
            }
          }
        }
        video.playbackRate = s.speed;
        if (!avPrimed) {
          video.volume = s.volume;
          video.muted = false;
          avPrimed = true;
        }
      };
      video.addEventListener("loadedmetadata", applyNative, { once: true });
      cleanup.push(() =>
        video.removeEventListener("loadedmetadata", applyNative)
      );

      const at = (video as unknown as { audioTracks?: NativeAudioTrackList })
        .audioTracks;
      const tt = video.textTracks as unknown as TextTrackList | undefined;
      const onNativeChange = () => {
        let audio = "en";
        let subs: string | "off" = "off";
        if (at) {
          for (let i = 0; i < at.length; i++) {
            if (at[i].enabled) audio = at[i].language;
          }
        }
        // Overlay uses mode "hidden" (not "showing") — treat both as active
        // so we don't poison persisted settings back to subs:"off".
        demoteShowingTracks(video);
        if (tt) {
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i];
            if (
              (t.kind === "subtitles" || t.kind === "captions") &&
              t.mode !== "disabled"
            ) {
              subs = t.language || "en";
            }
          }
        }
        saveVixSettings({ audio, subs });
      };
      at?.addEventListener?.("change", onNativeChange);
      tt?.addEventListener?.("change", onNativeChange);
      cleanup.push(() => {
        at?.removeEventListener?.("change", onNativeChange);
        tt?.removeEventListener?.("change", onNativeChange);
      });

      // Safari native path: Auto cascade + forced VDRK/OpenSubtitles via
      // injected text tracks. Native HLS has no hls.subtitleTrack.
      const loadSafariExternal = async () => {
        const src = subSourceRef.current;
        if (src === "off") {
          applyNative();
          return;
        }
        if (src === "stream") {
          applyNative();
          return;
        }

        const delay = loadVixSettings().subDelaySeconds;
        const ttl = video.textTracks as unknown as TextTrackList | undefined;
        const hasEngTrack = (() => {
          if (!ttl) return false;
          for (let i = 0; i < ttl.length; i++) {
            const t = ttl[i];
            if (
              (t.kind === "subtitles" || t.kind === "captions") &&
              t.mode !== "disabled" &&
              matchLang(t.language, "en")
            ) {
              return true;
            }
          }
          return false;
        })();

        if (src === "auto") {
          applyNative();
          if (hasEngTrack) return;
          // Cascade VDRK → OS when stream has no English CC showing.
          for (const source of ["vdrk", "opensub"] as const) {
            const ext = await fetchExternalVtt({
              source,
              type,
              tmdbId,
              season,
              episode,
              imdbId: imdbIdRef.current,
            });
            if (ext) {
              if (ttl) {
                for (let i = 0; i < ttl.length; i++) {
                  const t = ttl[i];
                  if (t.kind === "subtitles" || t.kind === "captions") {
                    t.mode = "hidden";
                  }
                }
              }
              externalVttRef.current = { vtt: ext.vtt, label: ext.label };
              setHasExternalSubs(true);
              const tr = injectVttTrack(
                video,
                ext.vtt,
                ext.label,
                loadVixSettings().subs !== "off",
                delay
              );
              if (tr) injectedTracksRef.current.push(tr);
              return;
            }
          }
          return;
        }

        // Forced external — hide stream CC first.
        if (ttl) {
          for (let i = 0; i < ttl.length; i++) {
            const t = ttl[i];
            if (t.kind === "subtitles" || t.kind === "captions") {
              t.mode = "hidden";
            }
          }
        }
        const ext = await fetchExternalVtt({
          source: src,
          type,
          tmdbId,
          season,
          episode,
          imdbId: imdbIdRef.current,
        });
        if (ext) {
          externalVttRef.current = { vtt: ext.vtt, label: ext.label };
          setHasExternalSubs(true);
          const tr = injectVttTrack(video, ext.vtt, ext.label, true, delay);
          if (tr) injectedTracksRef.current.push(tr);
        } else if (src === "vdrk" || src === "opensub") {
          revertExternalSub(src);
        }
      };
      reloadSubsRef.current = () => {
        // Offline with stored subs: the mounted track stays, period.
        if (offlineStoredSubs) return;
        for (const t of injectedTracksRef.current) t.mode = "disabled";
        injectedTracksRef.current = [];
        externalVttRef.current = null;
        setHasExternalSubs(false);
        void loadSafariExternal();
      };
      reapplyExternalSubsRef.current = () => {
        const cached = externalVttRef.current;
        if (!cached) return;
        for (const t of injectedTracksRef.current) t.mode = "disabled";
        injectedTracksRef.current = [];
        const ttl = video.textTracks as unknown as TextTrackList | undefined;
        if (ttl) {
          for (let i = 0; i < ttl.length; i++) {
            const t = ttl[i];
            if (t.kind === "subtitles" || t.kind === "captions") {
              t.mode = "hidden";
            }
          }
        }
        const delay = loadVixSettings().subDelaySeconds;
        const tr = injectVttTrack(
          video,
          cached.vtt,
          cached.label,
          loadVixSettings().subs !== "off",
          delay
        );
        if (tr) injectedTracksRef.current.push(tr);
      };
      // Auto + forced external both need a settle delay for textTracks.
      // Skipped offline with stored subs (nothing to load).
      const src0 = subSourceRef.current;
      if (src0 !== "off" && !offlineStoredSubs) {
        safariTimerRef.current = window.setTimeout(
          () => void loadSafariExternal(),
          1200
        );
      }
      // Safari native HLS: no startPosition — retry seek after metadata/fragments.
      const pos = readPendingSeek(pendingSeekPosRef);
      if (pos != null) {
        const run = () => {
          if (pendingSeekSettled) return;
          void seekVideoElement(video, pos, {
            play: true,
            shouldAbort: () => readPendingSeek(pendingSeekPosRef) !== pos,
          }).then((ok) => {
            if (ok) notifySeekSettled(pos, true);
          });
        };
        if (video.readyState >= 1) run();
        else video.addEventListener("loadedmetadata", run, { once: true });
        window.setTimeout(run, 600);
        window.setTimeout(run, 1500);
        window.setTimeout(run, 3000);
        pendingSeekTimer = window.setTimeout(() => {
          if (pendingSeekSettled) return;
          const near =
            Number.isFinite(video.currentTime) &&
            Math.abs(video.currentTime - pos) <= 2.5;
          notifySeekSettled(pos, near);
        }, 15_000);
      }

      // Native HLS has no hls.js error pipeline: a hole in an offline
      // playlist or a decode failure otherwise loops on "Starting…" with no
      // way out. Hop past the bad fragment (same 15s trick as the hls.js
      // offline recovery) a couple of times, then hand control back so the
      // user is never stuck on a frozen player.
      let nativeErrors = 0;
      const onNativeError = () => {
        const err = video.error;
        if (!err || err.code === MediaError.MEDIA_ERR_ABORTED) return;
        const pos = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const recoverable =
          err.code === MediaError.MEDIA_ERR_NETWORK ||
          err.code === MediaError.MEDIA_ERR_DECODE;
        if (recoverable && pos > 0 && nativeErrors < MAX_FATAL_ERRORS - 1) {
          const dur = Number.isFinite(video.duration)
            ? video.duration
            : pos + OFFLINE_HOP_SECONDS;
          const hop = Math.min(pos + OFFLINE_HOP_SECONDS, Math.max(0, dur - 1));
          if (hop > pos) {
            nativeErrors += 1;
            const wasPlaying = !video.paused && !video.ended;
            // Track settings live on the element — re-apply after the reload.
            video.addEventListener("loadedmetadata", applyNative, { once: true });
            video.src = `${playlistUrl}#t=${hop.toFixed(3)}`;
            if (wasPlaying) {
              window.setTimeout(() => {
                if (video.paused && !video.ended) void video.play().catch(() => {});
              }, 300);
            }
            return;
          }
        }
        if (pos > 0) savePosition(pos, video.duration, true);
        setStreamFailed(true);
      };
      video.addEventListener("error", onNativeError);
      cleanup.push(() => video.removeEventListener("error", onNativeError));
    } else {
      setStreamFailed(true);
    }

    // Speed + volume persist on both paths.
    const onRate = () => saveVixSettings({ speed: video.playbackRate });
    const onVol = () => {
      // Persist volume only — muted is session-only (never sync / restore).
      saveVixSettings({ volume: video.volume });
    };
    // Effective rendition for the Auto pill: hls.js reports LEVEL_SWITCHED;
    // Safari native has no levels API, so videoHeight on resize is the source.
    const onResize = () => {
      if (Number.isFinite(video.videoHeight) && video.videoHeight > 0) {
        setEffectiveQualityRef.current?.(video.videoHeight);
      }
    };
    video.addEventListener("ratechange", onRate);
    video.addEventListener("volumechange", onVol);
    video.addEventListener("resize", onResize);
    cleanup.push(() => {
      video.removeEventListener("ratechange", onRate);
      video.removeEventListener("volumechange", onVol);
      video.removeEventListener("resize", onResize);
    });

    return () => {
      hls?.destroy();
      if (bootstrapTimer != null) window.clearTimeout(bootstrapTimer);
      if (pendingSeekTimer != null) window.clearTimeout(pendingSeekTimer);
      setHlsAudioTrackRef.current = null;
      setHlsQualityRef.current = null;
      setEffectiveQualityRef.current = null;
      setAudioTracks([]);
      setQualityLevels([]);
      // Disable + drop injected external tracks so an episode change (or an
      // in-place vix↔goated source switch that reuses the same <video>) never
      // leaves a stale "showing" track or leaks duplicates.
      // Offline stored subs belong to the HOST, not this cascade: the <video>
      // dies with the remount anyway, and wiping here strands a re-attach
      // (speed/volume change re-runs this effect) with no subs left to show.
      if (!offlineStoredSubs) {
        for (const t of injectedTracksRef.current) t.mode = "disabled";
        injectedTracksRef.current = [];
        externalVttRef.current = null;
        setHasExternalSubs(false);
      }
      reloadSubsRef.current = null;
      reapplyExternalSubsRef.current = null;
      if (safariTimerRef.current != null) {
        window.clearTimeout(safariTimerRef.current);
        safariTimerRef.current = null;
      }
      for (const fn of cleanup) fn();
    };
}
