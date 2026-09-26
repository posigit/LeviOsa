/**
 * Offline HLS: canonical media keys, playlist parsing, offline rewrites,
 * variant/audio picking, byte estimates. Pure functions (no storage, no
 * network) — safe to unit-test and to mirror against public/sw.js.
 */
export function dlPlaylistUrl(key: string): string {
  return `/api/dl?playlist=${encodeURIComponent(key)}`;
}

/** Offline serve URL for one cached segment/key file. */
export function dlFileUrl(canonical: string): string {
  return `/api/dl?u=${encodeURIComponent(canonical)}`;
}

/* ------------------------------------------------------------------ */
/* Canonical media keys: stable identity across signed-URL rotations.     */
/* The service worker serves these keys by exact match (no normalization  */
/* on its side), so this file is the single owner of key shape.          */
/* ------------------------------------------------------------------ */

/** Query params stripped from media URLs (signed-URL rotation). Exported for the sw.js parity test. */
export const VOLATILE_PARAMS = ["token", "expires", "asn"];

function stripVolatile(raw: string): string {
  try {
    const u = new URL(raw, "http://localhost");
    for (const k of VOLATILE_PARAMS) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Stable identity for a segment/key URL across signed-URL rotations.
 * Unwraps one level of same-origin proxy (`?url=<inner>`) then strips
 * volatile params. `media:` prefix avoids collisions with playlist keys.
 */
export function canonicalMediaKey(raw: string): string {
  const unwrap = (s: string): string => {
    try {
      const u = new URL(s, "http://localhost");
      const inner = u.searchParams.get("url");
      if (inner) return unwrap(inner);
      return stripVolatile(s);
    } catch {
      return s;
    }
  };
  return `media:${unwrap(raw)}`;
}
/* ------------------------------------------------------------------ */
/* HLS parsing                                                         */
/* ------------------------------------------------------------------ */

export type VariantInfo = {
  bandwidth: number;
  height: number;
  width: number;
  codecs: string | null;
  /** EXT-X-MEDIA audio GROUP-ID when the variant uses separate audio. */
  audioGroup: string | null;
  url: string;
};

export function isMasterPlaylist(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF");
}

export function parseMasterVariants(
  text: string,
  baseUrl: string
): VariantInfo[] {
  const lines = text.split(/\r?\n/);
  const out: VariantInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    const codecs = /CODECS="([^"]+)"/.exec(line)?.[1] ?? null;
    const audioGroup = /AUDIO="([^"]+)"/.exec(line)?.[1] ?? null;
    const uri = (lines[i + 1] ?? "").trim();
    if (!uri || uri.startsWith("#")) continue;
    try {
      out.push({
        bandwidth: bw,
        height: res ? Number(res[2]) : 0,
        width: res ? Number(res[1]) : 0,
        codecs,
        audioGroup,
        url: new URL(uri, baseUrl).toString(),
      });
    } catch {
      /* skip unresolvable URI */
    }
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

/** Highest variant at or under the target height; "best" = top bandwidth.
 * Returns null when nothing fits (callers report the gap so the user can
 * switch quality) — never silently upscales to a heavier rendition. */
export function pickVariant(
  variants: VariantInfo[],
  quality: 480 | 720 | 1080 | "best"
): VariantInfo | null {
  if (variants.length === 0) return null;
  if (quality === "best") return variants[0] ?? null;
  const withHeight = variants.filter((v) => v.height > 0);
  if (withHeight.length === 0) return variants[variants.length - 1] ?? null;
  const fitting = withHeight
    .filter((v) => v.height <= quality)
    .sort((a, b) => b.height - a.height);
  if (fitting.length > 0) return fitting[0] ?? null;
  return null;
}

/** Smallest known rendition height (for "not available in …" messages). */
export function minVariantHeight(variants: VariantInfo[]): number | null {
  const heights = variants
    .map((v) => v.height)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);
  return heights[0] ?? null;
}

export type MediaParts = {
  segments: string[];
  mapUrl: string | null;
  keys: { method: string; url: string }[];
  durationSec: number;
  sampleAes: boolean;
};

export function parseMediaPlaylist(
  text: string,
  baseUrl: string
): MediaParts {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments: string[] = [];
  const keys: { method: string; url: string }[] = [];
  let mapUrl: string | null = null;
  let durationSec = 0;
  let expectSegment = false;
  let sampleAes = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) {
        try {
          mapUrl = new URL(m[1] ?? "", baseUrl).toString();
        } catch {
          /* ignore */
        }
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const method = /METHOD=([^,]+)/.exec(line)?.[1]?.trim() ?? "NONE";
      const m = /URI="([^"]+)"/.exec(line);
      if (m) {
        try {
          keys.push({ method, url: new URL(m[1] ?? "", baseUrl).toString() });
        } catch {
          /* ignore */
        }
      }
      if (method === "SAMPLE-AES") sampleAes = true;
    } else if (line.startsWith("#EXTINF:")) {
      durationSec += Number(line.slice(8).split(",")[0]) || 0;
      expectSegment = true;
    } else if (expectSegment) {
      expectSegment = false;
      if (line && !line.startsWith("#")) {
        try {
          segments.push(new URL(line, baseUrl).toString());
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { segments, mapUrl, keys, durationSec, sampleAes };
}

/**
 * Rewrite a media playlist so every segment / init / key URI points at the
 * offline serve path. Bare URI lines and URI="..." attributes both handled;
 * already-offline URLs pass through untouched.
 */
export function rewritePlaylistForOffline(
  text: string,
  baseUrl: string,
  gaps: ReadonlySet<string> = new Set()
): string {
  const lines = text.split(/\r?\n/);
  let expectSegment = false;
  return lines
    .map((rawLine) => {
      const line = rawLine.trim();
      if (line.startsWith("#EXT-X-MAP:") || line.startsWith("#EXT-X-KEY:")) {
        return rawLine.replace(/URI="([^"]+)"/, (_m, uri: string) => {
          if (String(uri).startsWith("/api/dl?")) return `URI="${uri}"`;
          try {
            const abs = new URL(String(uri), baseUrl).toString();
            return `URI="${dlFileUrl(canonicalMediaKey(abs))}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      if (line.startsWith("#EXTINF:")) {
        expectSegment = true;
        return rawLine;
      }
      if (expectSegment) {
        expectSegment = false;
        if (line && !line.startsWith("#")) {
          if (line.startsWith("/api/dl?")) return rawLine;
          try {
            const abs = new URL(line, baseUrl).toString();
            const rewritten = dlFileUrl(canonicalMediaKey(abs));
            // Encoder-declared gap: the segment is dead upstream (persistently
            // empty). Players skip it instead of stalling on a 404.
            if (gaps.has(rewritten)) return `#EXT-X-GAP\n${rewritten}`;
            return rewritten;
          } catch {
            return rawLine;
          }
        }
      }
      return rawLine;
    })
    .join("\n");
}

export function estimateBytes(bandwidth: number, durationSec: number): number {
  if (!bandwidth || !durationSec) return 0;
  return Math.round((bandwidth / 8) * durationSec);
}

/* ------------------------------------------------------------------ */
/* Separate-audio renditions (vix-style masters)                       */
/* ------------------------------------------------------------------ */

export type AudioEntry = {
  groupId: string;
  name: string;
  language: string;
  isDefault: boolean;
  url: string;
};

/** All TYPE=AUDIO EXT-X-MEDIA renditions in a master playlist. */
export function parseMasterAudio(text: string, baseUrl: string): AudioEntry[] {
  const out: AudioEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    if (!/TYPE=AUDIO/.test(line)) continue;
    const uri = /URI="([^"]+)"/.exec(line)?.[1];
    if (!uri) continue;
    try {
      out.push({
        groupId: /GROUP-ID="([^"]+)"/.exec(line)?.[1] ?? "",
        name: /NAME="([^"]+)"/.exec(line)?.[1] ?? "Audio",
        language: /LANGUAGE="([^"]+)"/.exec(line)?.[1] ?? "",
        isDefault: /DEFAULT=YES/.test(line),
        url: new URL(uri, baseUrl).toString(),
      });
    } catch {
      /* skip unresolvable URI */
    }
  }
  return out;
}

/** Prefer the user's audio language, else the source default, else first. */
export function pickAudioEntry(
  entries: AudioEntry[],
  wantLang: string,
  match: (lang: string | undefined, want: string) => boolean
): AudioEntry | null {
  if (entries.length === 0) return null;
  const group = entries;
  const byLang = group.find(
    (e) => match(e.language, wantLang) || match(e.name, wantLang)
  );
  if (byLang) return byLang;
  const def = group.find((e) => e.isDefault);
  if (def) return def;
  return group[0] ?? null;
}

/**
 * Minimal synthetic master pointing hls.js at the stored video + audio
 * playlists. Stream SUBTITLES groups are deliberately dropped — offline
 * subs come from the downloaded external VTT instead.
 */
export function buildOfflineMaster(opts: {
  variant: VariantInfo;
  videoPlaylistUrl: string;
  audio: AudioEntry | null;
  audioPlaylistUrl: string | null;
}): string {
  const res =
    opts.variant.width > 0 && opts.variant.height > 0
      ? `,RESOLUTION=${opts.variant.width}x${opts.variant.height}`
      : "";
  const codecs = opts.variant.codecs ? `,CODECS="${opts.variant.codecs}"` : "";
  const audioAttr =
    opts.audio && opts.audioPlaylistUrl ? `,AUDIO="offline-audio"` : "";
  const lines = ["#EXTM3U"];
  if (opts.audio && opts.audioPlaylistUrl) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="offline-audio",NAME="${opts.audio.name}",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="${opts.audio.language || "und"}",URI="${opts.audioPlaylistUrl}"`
    );
  }
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${opts.variant.bandwidth}${res}${codecs}${audioAttr}`,
    opts.videoPlaylistUrl
  );
  return lines.join("\n");
}
