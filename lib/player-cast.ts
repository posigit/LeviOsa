import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  CastPlayerControllerLike,
  CastRemotePlayerLike,
} from "@/lib/cast-types";

type TransportSnapshot = {
  currentTime: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
};

type UseCastRemoteOptions = {
  mode: "loading" | "native" | "iframe" | "error";
  playlistUrl: string | null;
  title: string;
  bumpChrome: () => void;
  videoRef: { current: HTMLVideoElement | null };
  remotePositionRef: { current: number };
  setTransport: Dispatch<SetStateAction<TransportSnapshot>>;
};

export function useCastRemote({
  mode,
  playlistUrl,
  title,
  bumpChrome,
  videoRef,
  remotePositionRef,
  setTransport,
}: UseCastRemoteOptions) {
  /** Chromecast: framework ready + active session. Native mode only. */
  const [castReady, setCastReady] = useState(false);
  const [casting, setCasting] = useState(false);
  const castingRef = useRef(false);
  const castPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    castingRef.current = casting;
  }, [casting]);
  /** Shared Cast receiver handle - one RemotePlayer per mount, never per call. */
  const castRemoteRef = useRef<{
    remote: CastRemotePlayerLike;
    controller: CastPlayerControllerLike;
  } | null>(null);

  /** One shared Cast receiver handle per mount (never a fresh RemotePlayer per call). */
  const getCastRemote = useCallback(() => {
    try {
      const framework = window.chrome?.framework;
      if (!framework) return null;
      if (!castRemoteRef.current) {
        const remote = new framework.RemotePlayer();
        castRemoteRef.current = {
          remote,
          controller: new framework.RemotePlayerController(remote),
        };
      }
      return castRemoteRef.current;
    } catch {
      return null;
    }
  }, []);

  // Load the Cast sender SDK once; readiness gates the chrome button.
  // Restores the previous __onGCastApiAvailable on unmount and subscribes to
  // externally-initiated session ends (receiver stop, second sender).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.chrome?.framework) {
      setCastReady(true);
      return;
    }
    if (document.querySelector('script[data-cast-sender="1"]')) return;
    let cancelled = false;
    const prev = window.__onGCastApiAvailable;
    const ours = (available: boolean) => {
      if (cancelled || !available) return;
      try {
        const framework = window.chrome?.framework;
        if (!framework) return;
        framework.CastContext.getInstance().setOptions({
          receiverApplicationId:
            window.chrome?.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: window.chrome?.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });
        try {
          framework.CastContext.getInstance().addEventListener(
            "sessionstatechanged",
            () => {
              try {
                if (!framework.CastContext.getInstance().getCurrentSession()) {
                  if (castPollRef.current) {
                    clearInterval(castPollRef.current);
                    castPollRef.current = null;
                  }
                  castRemoteRef.current = null;
                  setCasting(false);
                }
              } catch {
                /* ignore */
              }
            }
          );
        } catch {
          /* session listener unsupported — poll still detects local ends */
        }
        setCastReady(true);
      } catch {
        /* Cast init failed — button stays hidden */
      }
    };
    window.__onGCastApiAvailable = ours;
    const s = document.createElement("script");
    s.dataset.castSender = "1";
    s.src =
      "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    s.async = true;
    s.onerror = () => {
      if (!cancelled) setCastReady(false);
    };
    document.head.appendChild(s);
    return () => {
      cancelled = true;
      if (window.__onGCastApiAvailable === ours) {
        window.__onGCastApiAvailable = prev;
      }
    };
  }, []);

  const stopCastPoll = useCallback(() => {
    if (castPollRef.current) {
      clearInterval(castPollRef.current);
      castPollRef.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      stopCastPoll();
      castRemoteRef.current = null;
    },
    [stopCastPoll]
  );

  /** Load current media on the Cast receiver and mirror transport to it. */
  const startCast = useCallback(async () => {
    if (mode !== "native" || !playlistUrl) return;
    const framework = window.chrome?.framework;
    const castMedia = window.chrome?.cast.media;
    if (!framework || !castMedia) return;
    try {
      const context = framework.CastContext.getInstance();
      let session = context.getCurrentSession();
      if (!session) {
        await context.requestSession();
        session = context.getCurrentSession();
      }
      if (!session) return;
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(playlistUrl, window.location.origin).toString();
      } catch {
        return;
      }
      const metadata = new castMedia.GenericMediaMetadata();
      metadata.metadataType = castMedia.MetadataType.GENERIC;
      metadata.title = title;
      const mediaInfo = new castMedia.MediaInfo(
        absoluteUrl,
        "application/x-mpegurl"
      );
      mediaInfo.streamType = castMedia.StreamType.BUFFERED;
      mediaInfo.metadata = metadata;
      const v = videoRef.current;
      const pos =
        v && Number.isFinite(v.currentTime) && v.currentTime > 0
          ? v.currentTime
          : remotePositionRef.current;
      const req = new castMedia.LoadRequest(mediaInfo);
      req.autoplay = true;
      req.currentTime = Math.max(0, pos);
      await session.loadMedia(req);
      try {
        v?.pause();
      } catch {
        /* ignore */
      }
      setCasting(true);
      bumpChrome();
      stopCastPoll();
      // Mirror receiver clock into our transport (progress saves keep working).
      // Reuses the single shared RemotePlayer — never a fresh one per tick.
      const pair = getCastRemote();
      if (!pair) return;
      const { remote } = pair;
      castPollRef.current = setInterval(() => {
        try {
          if (!castingRef.current) return;
          setTransport((t) => ({
            ...t,
            currentTime:
              Number.isFinite(remote.currentTime) && remote.currentTime >= 0
                ? remote.currentTime
                : t.currentTime,
            duration:
              Number.isFinite(remote.duration) && remote.duration > 0
                ? remote.duration
                : t.duration,
            paused: remote.isPaused,
          }));
        } catch {
          /* receiver quiet — keep last known clock */
        }
      }, 1000);
    } catch {
      /* picker dismissed or load failed — stay local */
      bumpChrome();
    }
  }, [mode, playlistUrl, title, stopCastPoll, bumpChrome, getCastRemote, videoRef, remotePositionRef, setTransport]);

  const stopCast = useCallback(() => {
    try {
      window.chrome?.framework.CastContext.getInstance()
        .getCurrentSession()
        ?.endSession(true);
    } catch {
      /* ignore */
    }
    stopCastPoll();
    setCasting(false);
    bumpChrome();
  }, [stopCastPoll, bumpChrome]);

  /** Remote play/pause while casting (transport intercepts below). */
  const castPlayPause = useCallback(() => {
    try {
      getCastRemote()?.controller.playOrPause();
    } catch {
      /* ignore */
    }
    bumpChrome();
  }, [bumpChrome, getCastRemote]);

  const castSeekBy = useCallback((delta: number) => {
    try {
      const pair = getCastRemote();
      if (!pair) return false;
      const { remote, controller } = pair;
      const dur = remote.duration;
      const target = remote.currentTime + delta;
      remote.currentTime = Math.max(
        0,
        Number.isFinite(dur) && dur > 0 ? Math.min(target, dur) : target
      );
      controller.seek();
      return true;
    } catch {
      return false;
    }
  }, [getCastRemote]);

  const endCastForNewMedia = useCallback(() => {
    if (!castingRef.current) return;
    try {
      window.chrome?.framework.CastContext.getInstance()
        .getCurrentSession()
        ?.endSession(true);
    } catch {
      /* ignore */
    }
    setCasting(false);
  }, []);

  return {
    castReady,
    casting,
    castingRef,
    getCastRemote,
    startCast,
    stopCast,
    castPlayPause,
    castSeekBy,
    endCastForNewMedia,
  };
}
