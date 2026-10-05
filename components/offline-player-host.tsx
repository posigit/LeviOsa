"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VixPlayer } from "@/components/vix-player";
import { UpNextCard } from "@/components/up-next-card";
import {
  DL_CACHE,
  dlPlaylistUrl,
  getAllSync,
  getManifest,
  getRecordSync,
  readOfflinePosition,
  setPlaybackInUse,
  touchRecord,
  verifyRecordFiles,
  type DownloadRecord,
} from "@/lib/downloads";
import { isResumablePosition } from "@/lib/player-progress";
import { nextDownloadedEpisode, showNameOf } from "@/lib/offline/library";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";
import { loadVixSettings } from "@/lib/vix-settings";
import type { IntroDbSegments } from "@/lib/introdb";
import { useToast } from "@/components/toast";

/**
 * Global offline-playback host. Anything (settings sheet, download rows)
 * can request offline play via `requestOfflinePlay(recordKey)`; the host
 * mounts a VixPlayer wired straight at the cached playlist + stored subs,
 * skipping stream resolution entirely.
 *
 * The mount happens inside the tap's own task (record read from the warm
 * manifest cache) so autoplay keeps the user gesture; the byte check runs
 * BESIDE the open and closes it if the OS evicted the file.
 */
export function OfflinePlayerHost() {
  const { toast } = useToast();
  const [req, setReq] = useState<{
    key: string;
    nonce: number;
  } | null>(null);
  const [sub, setSub] = useState<{ vtt: string; label: string } | null>(null);
  /** Local stop position for auto-resume (jump straight, no prompt). */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  /** Segments captured with the download (offline skip/outro). */
  const [storedSegments, setStoredSegments] = useState<IntroDbSegments | null>(null);
  /** Stored spare subtitle files (best-first) for offline switching. */
  const [storedAlts, setStoredAlts] = useState<{ vtt: string; label: string }[] | null>(null);
  /** Cached master includes the captured HLS caption rendition. */
  const [preferStreamSubs, setPreferStreamSubs] = useState(false);
  const [meta, setMeta] = useState<{
    title: string;
    type: "movie" | "tv";
    tmdbId: number;
    season?: number;
    episode?: number;
    /** Known total duration — seeds the scrub bar before hls.js sets one. */
    durationSec?: number;
  } | null>(null);
  /** Next downloaded episode offered at the end of an episode (TV only). */
  const [upNext, setUpNext] = useState<DownloadRecord | null>(null);
  /** 10 → 1 auto-advance countdown; 0 = autoplay off (tap-to-play card). */
  const [upNextCount, setUpNextCount] = useState(0);
  /** True while the player reports paused — freezes the Up Next countdown. */
  const [playerPaused, setPlayerPaused] = useState(false);
  /** Where the card appeared — a scrub ≥30s behind it cancels auto-advance. */
  const upNextTriggerRef = useRef<number | null>(null);
  /** Pause events after "ended" (some embeds send one) must not freeze it. */
  const sawEndedRef = useRef(false);
  /** Bumped on every open/close — an in-flight verify can't close a newer player. */
  const openIdRef = useRef(0);

  const close = useCallback(() => {
    openIdRef.current += 1;
    setPlaybackInUse(null);
    setReq(null);
    setMeta(null);
    setSub(null);
    setResumeAt(null);
    setStoredSegments(null);
    setStoredAlts(null);
    setPreferStreamSubs(false);
    setUpNext(null);
    setUpNextCount(0);
    setPlayerPaused(false);
    upNextTriggerRef.current = null;
    sawEndedRef.current = false;
  }, []);

  const open = useCallback(
    (key: string) => {
      const mount = (rec: DownloadRecord) => {
        if (rec.state !== "done") {
          toast("That download isn't finished yet", "error");
          return;
        }
        const openId = ++openIdRef.current;
        void touchRecord(key);
        // Playing this download: quota LRU must not evict its bytes now.
        setPlaybackInUse(key);
        setSub(
          rec.subVtt ? { vtt: rec.subVtt, label: rec.subLabel ?? "Subtitles" } : null
        );
        // Auto-resume from the local stop position when still mid-way.
        const stored = readOfflinePosition(key);
        setResumeAt(
          stored && isResumablePosition(stored.pos, stored.dur)
            ? stored.pos
            : null
        );
        setStoredSegments(rec.segments ?? null);
        setStoredAlts(rec.subAlts?.length ? rec.subAlts : null);
        setPreferStreamSubs(false);
        setMeta({
          title: rec.title,
          type: rec.type === "movie" ? "movie" : "tv",
          tmdbId: rec.tmdbId,
          season: rec.season,
          episode: rec.episode,
          durationSec: rec.durationSec,
        });
        setUpNext(null);
        setUpNextCount(0);
        // Mount first — every await in front of this one spends the tap's
        // user gesture, which autoplay needs to start without a second tap.
        setReq({ key, nonce: Date.now() });
        // The playlist sniff is not on the gesture path. Old downloads have
        // no flag; the master either contains the captured rendition or not.
        void (async () => {
          try {
            const cache = await caches.open(DL_CACHE);
            const hit = await cache.match(dlPlaylistUrl(key));
            const text = hit ? await hit.text() : "";
            if (openIdRef.current !== openId) return;
            if (text.includes('GROUP-ID="offline-subs"')) setPreferStreamSubs(true);
          } catch {
            /* play the stored file if the cache can't be read */
          }
        })();
        void verifyRecordFiles(key).then((ok) => {
          if (ok || openIdRef.current !== openId) return;
          close();
          toast("Files were cleared — download it again", "error");
        });
      };
      // Warm manifest cache → mount inside this task (no await at all).
      const cached = getRecordSync(key);
      if (cached) {
        mount(cached);
        return;
      }
      void (async () => {
        const rec = (await getManifest())[key];
        if (!rec) {
          toast("Download not found", "error");
          return;
        }
        mount(rec);
      })();
    },
    [close, toast]
  );

  useEffect(() => {
    // Warm the manifest cache so the first Play tap takes the sync path.
    void getManifest();
    const onPlay = (e: Event) => {
      const key = (e as CustomEvent<{ key: string }>).detail?.key;
      if (!key) return;
      // /api/dl is served ONLY by the service worker (no app route exists).
      // Without a controlling SW the player would spin on 404s — say so.
      if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
        toast("Offline player isn't ready — reload once online, then retry", "error");
        return;
      }
      open(key);
    };
    window.addEventListener("tvtime:play-offline", onPlay);
    return () => window.removeEventListener("tvtime:play-offline", onPlay);
  }, [open, toast]);

  /**
   * Finishing a downloaded title parks a watched mark in the playback
   * outbox — the same one streaming uses — so it syncs once back online.
   * (This host previously passed no `onEvent`, so offline finishes never
   * reached /api/watch at all.)
   */
  const handlePlayerEvent = useCallback(
    (event: string, detail?: { t?: number; duration?: number }) => {
      if (event === "play") {
        sawEndedRef.current = false;
        setPlayerPaused(false);
        return;
      }
      if (event === "pause") {
        // Ignore a pause that arrives after the episode finished — some
        // embeds emit one at their end screen; it must not freeze the count.
        if (!sawEndedRef.current) setPlayerPaused(true);
        return;
      }
      if (
        event === "seeked" &&
        upNext != null &&
        upNextTriggerRef.current != null &&
        detail?.t != null &&
        detail.t < upNextTriggerRef.current - 30
      ) {
        // Scrubbed back out of the outro — the user is still watching.
        setUpNext(null);
        setUpNextCount(0);
        upNextTriggerRef.current = null;
        return;
      }
      if (event !== "ended" || !meta) return;
      sawEndedRef.current = true;
      const m = meta;
      void (async () => {
        try {
          const res =
            m.type === "tv"
              ? m.season != null && m.episode != null
                ? await postJsonOffline("/api/watch", {
                    showTmdbId: m.tmdbId,
                    seasonNumber: m.season,
                    episodeNumber: m.episode,
                    watched: true,
                  })
                : null
              : await postJsonOffline("/api/movie-watch", {
                  tmdbId: m.tmdbId,
                  status: "watched",
                });
          if (res && queuedOffline(res)) {
            toast("Watched — saved offline, will sync", "info");
          }
        } catch {
          /* server rejected the replay — the local bookmark is already cleared */
        }
      })();
    },
    [meta, toast, upNext]
  );

  /** Near-end: queue the next downloaded episode of this show (movies: none). */
  const handleNearEnd = useCallback(
    (pos?: { t?: number; duration?: number }) => {
      const key = req?.key;
      if (!key) return;
      const current = getAllSync().find((r) => r.key === key);
      if (!current) return;
      const next = nextDownloadedEpisode(getAllSync(), current);
      // No later finished download: stay on the current ending, no card.
      if (!next) return;
      // Remember where the card appeared: a scrub ≥30s behind this point
      // cancels auto-advance (the player only reports the post-seek position).
      upNextTriggerRef.current =
        pos?.t ?? pos?.duration ?? current.durationSec ?? null;
      setUpNext(next);
      setUpNextCount(loadVixSettings().autoplayNext ? 10 : 0);
    },
    [req]
  );

  const playUpNext = useCallback(() => {
    if (!upNext) return;
    open(upNext.key);
  }, [upNext, open]);

  // Count the card down; at 0 swap onto the next download. autoplayNext off
  // seeds 0, so the card sits there tap-to-play instead of advancing.
  // Frozen while the player is paused — a countdown that keeps ticking behind
  // a paused video would advance against the user's intent.
  useEffect(() => {
    if (!upNext || !req || upNextCount <= 0 || playerPaused) return;
    const t = window.setTimeout(() => {
      if (upNextCount <= 1) {
        playUpNext();
      } else {
        setUpNextCount(upNextCount - 1);
      }
    }, 1000);
    return () => window.clearTimeout(t);
  }, [upNext, req, upNextCount, playUpNext, playerPaused]);

  if (!req || !meta) return null;

  return (
    <VixPlayer
      key={`offline-${req.key}-${req.nonce}`}
      src={dlPlaylistUrl(req.key)}
      title={meta.title}
      type={meta.type}
      tmdbId={meta.tmdbId}
      season={meta.season}
      episode={meta.episode}
      autoResume={false}
      initialPosition={resumeAt}
      initialPlaylistUrl={dlPlaylistUrl(req.key)}
      offlineKey={req.key}
      initialSubVtt={sub}
      initialSubAlts={storedAlts}
      preferStreamSubs={preferStreamSubs}
      initialSegments={storedSegments}
      initialDuration={meta.durationSec ?? null}
      onEvent={handlePlayerEvent}
      onNearEnd={handleNearEnd}
      overlaySlot={
        upNext ? (
          <UpNextCard
            episode={{
              title: upNext.subtitle || undefined,
              seasonNumber: upNext.season ?? 1,
              episodeNumber: upNext.episode ?? 1,
            }}
            currentSeason={meta.season}
            countdown={upNextCount}
            onPlay={playUpNext}
            onCancel={() => {
              setUpNext(null);
              setUpNextCount(0);
            }}
            showTitle={showNameOf(upNext.title)}
          />
        ) : null
      }
      onClose={close}
    />
  );
}
