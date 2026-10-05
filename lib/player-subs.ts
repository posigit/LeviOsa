/**
 * Subtitle helpers for the native player: VTT inject, external fetch, styles.
 * Stream-embedded CC is demoted to "hidden" so SubtitleOverlay owns paint.
 */

import type { VixSettings } from "@/lib/vix-settings";

export const SUB_FONT_SCALE: Record<VixSettings["subFontSize"], number> = {
  xs: 0.75,
  sm: 1,
  md: 1.12,
  lg: 1.25,
};

export const SUB_COLORS: Record<VixSettings["subColor"], string> = {
  white: "#ffffff",
  yellow: "#ffe566",
  cyan: "#7dd3fc",
};

export type SubSource =
  | "auto"
  | "off"
  | "stream"
  | "vdrk"
  | "opensub"
  | "subdl";

/**
 * CC-menu row lock: with no connection and no stored track playing, the
 * network file providers (VDRK/OpenSubs/SubDL) can never load — picking
 * one just dies in a fetch → revert-to-Auto loop. Auto/Stream/Off need no
 * network, and stored-spare switching (Saved files) is local, so they stay
 * enabled. Pure (node-testable) — the chrome feeds it useOnline().
 */
export function isSubProviderLocked(
  online: boolean,
  hasStoredSubTrack: boolean,
  key: SubSource
): boolean {
  return (
    !online &&
    !hasStoredSubTrack &&
    (key === "vdrk" || key === "opensub" || key === "subdl")
  );
}

/**
 * Strip ASS/SSA formatting that leaks into real-world subtitle files
 * (OpenSubtitles SRTs converted from ASS especially): override blocks like
 * {\\an8} / {\\pos(400,570)}, \\N forced breaks, \\h hard spaces. Browsers
 * and our overlay render these literally, so remove them before paint.
 *
 * The brace pattern requires a backslash so literal dialogue braces
 * ("I {love} you") survive — ASS overrides always carry \\ commands.
 */
export function stripAssTags(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\h/g, " ");
}

export function parseVttTime(t: string): number {
  // SRT-style files use "HH:MM:SS,mmm" — normalize so seconds parse
  // (Number("01,500") is NaN, which silently dropped every cue).
  const parts = t.replace(/,/g, ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** Keep cues active for SubtitleOverlay without native ::cue paint. */
export function demoteShowingTracks(video: HTMLVideoElement) {
  const ttl = video.textTracks;
  for (let i = 0; i < ttl.length; i++) {
    const t = ttl[i];
    if (t.kind !== "subtitles" && t.kind !== "captions") continue;
    if (t.mode === "showing") t.mode = "hidden";
  }
}

/** Inject an external VTT as a native text track (overlay draws cues). */
export function injectVttTrack(
  video: HTMLVideoElement,
  vtt: string,
  label: string,
  show: boolean,
  delaySeconds = 0
): TextTrack | null {
  const track = video.addTextTrack("subtitles", label, "en");
  track.mode = show ? "hidden" : "disabled";
  const delay = Number.isFinite(delaySeconds) ? delaySeconds : 0;
  const lines = vtt.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/
    );
    if (m) {
      const start = Math.max(0, parseVttTime(m[1]) + delay);
      const end = Math.max(start + 0.05, parseVttTime(m[2]) + delay);
      i++;
      const text: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        text.push(lines[i]);
        i++;
      }
      const plain = text.join("\n").trim();
      const clean = stripAssTags(plain).trim();
      if (clean && isPromoCue(clean)) continue;
      try {
        track.addCue(new VTTCue(start, end, clean));
      } catch {
        /* skip malformed cue */
      }
    } else {
      i++;
    }
  }
  return track;
}

export type VttCue = { start: number; end: number; text: string };

/**
 * VDRK/OpenSubs files often open with a promo cue ("Visit xyz.ru …").
 * Drop cues that are pure advertising so the overlay never flashes spam.
 * Conservative: only matches URLs and known spam TLDs, never plain words.
 */
export function isPromoCue(text: string): boolean {
  return /(https?:\/\/|www\.|[\w-]+\.(ru|xyz|top|click|live|stream|sbs|mom|lol)\b)/i.test(
    text.trim()
  );
}

/**
 * Parse a WebVTT document into plain-text cues (no <video> element needed).
 * Used to render our own subtitles over iframe embeds (e.g. CineSrc) where
 * the embed's internal CC menu is hidden behind controls=false.
 */
export function parseVttCues(vtt: string, delaySeconds = 0): VttCue[] {
  const delay = Number.isFinite(delaySeconds) ? delaySeconds : 0;
  const cues: VttCue[] = [];
  const lines = vtt.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/
    );
    if (m) {
      const start = Math.max(0, parseVttTime(m[1]) + delay);
      const end = Math.max(start + 0.05, parseVttTime(m[2]) + delay);
      i++;
      const text: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        text.push(lines[i]);
        i++;
      }
      const plain = stripAssTags(
        text
          .join("\n")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
      ).trim();
      if (plain && !isPromoCue(plain)) cues.push({ start, end, text: plain });
    } else {
      i++;
    }
  }
  return cues;
}

/** Active cue text at time t (seconds). */
export function cueTextAt(cues: VttCue[], t: number): string {
  if (!Number.isFinite(t)) return "";
  const lines: string[] = [];
  for (const c of cues) {
    if (t >= c.start && t < c.end) lines.push(c.text);
  }
  return lines.join("\n");
}

export type ExternalVttResult = {
  vtt: string;
  label: string;
  fileId?: SubFileId;
};

/**
 * OpenSubtitles file ids are numbers; SubDL ids are its download paths
 * ("/subtitle/{n_id}-{file_n_id}.zip"). The CC picker and both API routes
 * treat them as opaque keys, so one union covers both.
 */
export type SubFileId = number | string;

/** One row of the CC file picker — shared by OpenSubs and SubDL. */
export type SubFileItem = {
  fileId: SubFileId;
  label: string;
  downloads: number;
  format: string;
};

/** Legacy name for the same row type (existing props/imports). */
export type OpenSubListItem = SubFileItem;

/**
 * SRT -> WebVTT. Strips ASS remnants first (OpenSubtitles/SubDL SRTs
 * converted from ASS carry {\an8}-style overrides browsers render literally).
 */
export function srtToVtt(srt: string): string {
  const cleaned = stripAssTags(srt)
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/\n{3,}/g, "\n\n");
  const lines = cleaned.split("\n");
  const body = lines
    .filter((line, i) => {
      if (!/^\d+$/.test(line.trim())) return true;
      // Cue indexes are a bare number whose next content line is a timestamp.
      // A cue whose text is only a number ("42", "911") must stay.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        return !/^\d{2}:\d{2}/.test(next);
      }
      return true;
    })
    .join("\n")
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/**
 * Any downloaded subtitle becomes a VTT document: pass through real VTT,
 * convert classic SRT (comma millis), convert anything else the same way.
 */
export function toVtt(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "");
  if (text.trimStart().toUpperCase().startsWith("WEBVTT")) return text;
  return srtToVtt(text);
}

/**
 * English-latin sanity check for a downloaded file. SubDL lets uploaders tag
 * any file "EN", so an entry can come back in Persian/Arabic script — reject
 * those instead of storing junk under an English label (only Latin-script
 * English survives; Spanish/French etc. are Latin too and pass).
 */
export function looksLatin(text: string): boolean {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length < 40) return true; // too short to judge
  const ascii = text.match(/[A-Za-z]/g);
  const asciiCount = ascii ? ascii.length : 0;
  return asciiCount / letters.length >= 0.6;
}

/**
 * Fetch an external VTT (VDRK / OpenSubtitles / SubDL) for the current item.
 * Returns { vtt, label } or null.
 * For opensub/subdl, pass fileId to download a specific list pick.
 */
export async function fetchExternalVtt(opts: {
  source: "vdrk" | "opensub" | "subdl";
  type?: "movie" | "tv";
  tmdbId?: number;
  season?: number;
  episode?: number;
  imdbId?: string | null;
  /** Specific list pick (OpenSubtitles file id, SubDL path). */
  fileId?: SubFileId;
  label?: string;
  /** Optional abort (offline engine pauses) — player callers omit it. */
  signal?: AbortSignal;
}): Promise<ExternalVttResult | null> {
  if (opts.source === "vdrk") {
    if (!opts.tmdbId) return null;
    try {
      const base = `https://cache.vdrk.site/v1/vtt/${opts.type === "tv" ? "tv" : "movie"}/${opts.tmdbId}`;
      const path =
        opts.type === "tv" && opts.season != null && opts.episode != null
          ? `${base}/${opts.season}/${opts.episode}/English.vtt`
          : `${base}/English.vtt`;
      const res = await fetch(path, { signal: opts.signal });
      if (!res.ok) return null;
      const vtt = await res.text();
      if (vtt.trim().length === 0) return null;
      return { vtt, label: "English (VDRK)" };
    } catch {
      return null;
    }
  }

  if (opts.source === "subdl") {
    // SubDL keys on TMDB ids (IMDb is only a fallback), so embeds that never
    // resolve IMDb still get subtitles.
    if (!opts.tmdbId && !opts.imdbId) return null;
    try {
      const q = new URLSearchParams({ lang: "en" });
      if (opts.tmdbId) q.set("tmdbId", String(opts.tmdbId));
      if (opts.type) q.set("type", opts.type);
      if (opts.imdbId) q.set("imdbId", opts.imdbId);
      if (opts.season != null) q.set("season", String(opts.season));
      if (opts.episode != null) q.set("episode", String(opts.episode));
      if (opts.fileId != null) {
        q.set("fileId", String(opts.fileId));
        if (opts.label) q.set("label", opts.label);
      }
      const res = await fetch(`/api/subdl?${q.toString()}`, {
        signal: opts.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        vtt?: string;
        label?: string;
        fileId?: SubFileId;
      };
      if (!data.vtt) return null;
      return {
        vtt: data.vtt,
        label: data.label ?? "SubDL (English)",
        fileId: data.fileId,
      };
    } catch {
      return null;
    }
  }

  if (!opts.imdbId) return null;
  try {
    const q = new URLSearchParams({ imdbId: opts.imdbId, lang: "en" });
    if (opts.season != null) q.set("season", String(opts.season));
    if (opts.episode != null) q.set("episode", String(opts.episode));
    if (opts.fileId != null) {
      q.set("fileId", String(opts.fileId));
      if (opts.label) q.set("label", opts.label);
    }
    const res = await fetch(`/api/vixsrc/subs?${q.toString()}`, {
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      vtt?: string;
      label?: string;
      fileId?: number;
    };
    if (!data.vtt) return null;
    return {
      vtt: data.vtt,
      label: data.label ?? "OpenSubtitles (English)",
      fileId: data.fileId,
    };
  } catch {
    return null;
  }
}

/** List OpenSubtitles English files (no download). */
export async function listOpenSubtitles(opts: {
  imdbId?: string | null;
  season?: number;
  episode?: number;
}): Promise<SubFileItem[]> {
  if (!opts.imdbId) return [];
  try {
    const q = new URLSearchParams({
      imdbId: opts.imdbId,
      lang: "en",
      list: "1",
    });
    if (opts.season != null) q.set("season", String(opts.season));
    if (opts.episode != null) q.set("episode", String(opts.episode));
    const res = await fetch(`/api/vixsrc/subs?${q.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: SubFileItem[] };
    // Player only needs the top 3 ranked files.
    return Array.isArray(data.items) ? data.items.slice(0, 3) : [];
  } catch {
    return [];
  }
}

/** List SubDL English files (no download quota hit). */
export async function listSubDl(opts: {
  tmdbId?: number;
  type?: "movie" | "tv";
  imdbId?: string | null;
  season?: number;
  episode?: number;
}): Promise<SubFileItem[]> {
  if (!opts.tmdbId && !opts.imdbId) return [];
  try {
    const q = new URLSearchParams({ lang: "en", list: "1" });
    if (opts.tmdbId) q.set("tmdbId", String(opts.tmdbId));
    if (opts.type) q.set("type", opts.type);
    if (opts.imdbId) q.set("imdbId", opts.imdbId);
    if (opts.season != null) q.set("season", String(opts.season));
    if (opts.episode != null) q.set("episode", String(opts.episode));
    const res = await fetch(`/api/subdl?${q.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: SubFileItem[] };
    return Array.isArray(data.items) ? data.items.slice(0, 3) : [];
  } catch {
    return [];
  }
}
