"use client";

import { useEffect, useState, type MutableRefObject, type RefObject } from "react";
import { streamCueVisible } from "@/lib/player-subs";

/**
 * Renders active TextTrack cues in a div we fully control.
 * Native ::cue styling is unreliable with <video controls> / hls.js —
 * this is the only dependable way to do color / size / background.
 */
/** backdrop-blur utilities per blur step (full literals for Tailwind). */
export const SUB_BLUR_CLASS: Record<
  "none" | "sm" | "md" | "lg",
  string
> = {
  none: "",
  sm: "backdrop-blur-sm",
  md: "backdrop-blur-md",
  lg: "backdrop-blur-xl",
};

export function SubtitleOverlay({
  videoRef,
  enabled,
  fontScale,
  color,
  bgOpacity,
  bgBlur,
  /** When true, sit above the transport scrubber; otherwise low on the frame. */
  chromeRaised = false,
  delaySeconds = 0,
  bakedTracksRef = null,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  /** 1 = 100%, up to 1.25 = +25%. */
  fontScale: number;
  color: string;
  bgOpacity: number;
  bgBlur: "none" | "sm" | "md" | "lg";
  chromeRaised?: boolean;
  /** Slider delay. Stream cues shift by this. Baked tracks already include it. */
  delaySeconds?: number;
  bakedTracksRef?: MutableRefObject<TextTrack[]> | null;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled) {
      setText("");
      return;
    }

    const plain = (raw: string) =>
      raw
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim();
    const readCues = () => {
      const lines: string[] = [];
      const tracks = video.textTracks;
      const baked = bakedTracksRef?.current ?? [];
      const now = video.currentTime;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track.kind !== "subtitles" && track.kind !== "captions") continue;
        // "hidden" still exposes activeCues; "showing" would double-draw.
        if (track.mode === "disabled") continue;
        // Injected VTT already stored cue times plus the delay. Shifting
        // those again would move them twice. Stream cues are authored times.
        const shift = delaySeconds !== 0 && !baked.includes(track);
        const cues = shift ? track.cues : track.activeCues;
        if (!cues) continue;
        for (let j = 0; j < cues.length; j++) {
          const cue = cues[j] as VTTCue;
          if (
            shift &&
            !streamCueVisible(cue.startTime, cue.endTime, now, delaySeconds)
          ) {
            continue;
          }
          const text = plain(cue.text || "");
          if (text) lines.push(text);
        }
      }
      const next = lines.join("\n");
      setText((prev) => (prev === next ? prev : next));
    };

    const bind = () => {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].addEventListener("cuechange", readCues);
      }
      readCues();
    };

    bind();
    // Tracks appear asynchronously (hls / inject).
    const onAdd = () => bind();
    video.textTracks.addEventListener("addtrack", onAdd);
    video.addEventListener("timeupdate", readCues);
    const poll = window.setInterval(readCues, 500);

    return () => {
      window.clearInterval(poll);
      video.removeEventListener("timeupdate", readCues);
      video.textTracks.removeEventListener("addtrack", onAdd);
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].removeEventListener("cuechange", readCues);
      }
    };
  }, [videoRef, enabled, delaySeconds, bakedTracksRef]);

  if (!enabled || !text) return null;

  const fontPx = Math.round(18 * fontScale);

  // Sit near the bottom of the frame (Netflix-style). Only lift when the
  // transport scrubber is on screen so cues don't sit under the bar.
  // Mobile was reading as "mid frame" at 5.5rem / 2rem — keep these tight.
  const positionClass = chromeRaised
    ? "bottom-14 sm:bottom-16"
    : "bottom-3 sm:bottom-6";

  return (
    <CueShell
      text={text}
      fontPx={fontPx}
      color={color}
      bgOpacity={bgOpacity}
      bgBlur={bgBlur}
      positionClass={positionClass}
    />
  );
}

/**
 * Liquid-glass cue shell shared by native + iframe overlays.
 * bgOpacity 0 = bare text with shadow; otherwise frosted pill with blur step.
 */
export function CueShell({
  text,
  fontPx,
  color,
  bgOpacity,
  bgBlur,
  positionClass,
}: {
  text: string;
  fontPx: number;
  color: string;
  bgOpacity: number;
  bgBlur: "none" | "sm" | "md" | "lg";
  positionClass: string;
}) {
  const glass = bgOpacity > 0;
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-[25] flex justify-center px-3 sm:px-4 ${positionClass}`}
      style={{
        // Safe area without adding a large permanent lift on notched phones.
        paddingBottom: "max(0px, env(safe-area-inset-bottom))",
      }}
    >
      <p
        className={
          glass
            ? `max-w-[92%] whitespace-pre-wrap text-center font-medium leading-snug ring-1 ring-white/15 sm:max-w-[90%] ${SUB_BLUR_CLASS[bgBlur]}`
            : "max-w-[92%] whitespace-pre-wrap text-center font-medium leading-snug sm:max-w-[90%]"
        }
        style={{
          fontSize: fontPx,
          color,
          backgroundColor: glass
            ? `rgba(10, 10, 14, ${Math.max(0.35, bgOpacity)})`
            : "transparent",
          padding: glass ? "0.3em 0.8em" : 0,
          borderRadius: glass ? 12 : 4,
          textShadow: glass
            ? "0 1px 2px rgba(0,0,0,0.8)"
            : "0 1px 2px #000, 0 0 6px #000, 0 0 2px #000",
        }}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * Time-driven subtitle overlay for iframe embeds (no <video> element).
 * Cue timing comes from the embed's postMessage timeupdate position.
 */
export function IframeSubtitleOverlay({
  text,
  fontScale,
  color,
  bgOpacity,
  bgBlur,
  chromeRaised = false,
}: {
  text: string;
  /** 1 = 100%, up to 1.25 = +25%. */
  fontScale: number;
  color: string;
  bgOpacity: number;
  bgBlur: "none" | "sm" | "md" | "lg";
  /** When true, sit above the transport scrubber; otherwise low on the frame. */
  chromeRaised?: boolean;
}) {
  if (!text) return null;
  const fontPx = Math.round(18 * fontScale);
  const positionClass = chromeRaised
    ? "bottom-14 sm:bottom-16"
    : "bottom-3 sm:bottom-6";
  return (
    <CueShell
      text={text}
      fontPx={fontPx}
      color={color}
      bgOpacity={bgOpacity}
      bgBlur={bgBlur}
      positionClass={positionClass}
    />
  );
}
