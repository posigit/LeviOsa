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

/** Inclusive byte sub-range. HLS `#EXT-X-BYTERANGE` is length@offset. */
export type ByteRange = { start: number; length: number };

export type MediaSegment = {
  url: string;
  byteRange: ByteRange | null;
  /** AES-128 (ciphertext has no container magic). SAMPLE-AES is refused earlier. */
  encrypted: boolean;
};

export type MediaInit = { url: string; byteRange: ByteRange | null };

export type MediaParts = {
  segments: MediaSegment[];
  /** First init, or null. Every init lives in `maps` (discontinuities swap it). */
  mapUrl: string | null;
  maps: MediaInit[];
  keys: { method: string; url: string }[];
  durationSec: number;
  sampleAes: boolean;
  aes128: boolean;
};

/**
 * `#EXT-X-BYTERANGE:<length>[@<offset>]`. A missing offset continues from
 * `implicitStart` (the byte after the previous sub-range).
 */
export function parseByteRangeSpec(
  spec: string,
  implicitStart: number
): ByteRange | null {
  const m = /(\d+)(?:@(\d+))?/.exec(spec);
  if (!m) return null;
  const length = Number(m[1]);
  const start = m[2] != null ? Number(m[2]) : implicitStart;
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(start) || start < 0) {
    return null;
  }
  return { start, length };
}

/**
 * Cache identity for one stored piece. A byte range is part of the identity
 * so two slices of the same URL do not overwrite each other. `end` is the
 * inclusive last byte (`start + length - 1`).
 */
export function offlinePieceUrl(absoluteUrl: string, range?: ByteRange | null): string {
  let id = canonicalMediaKey(absoluteUrl);
  if (range) id += `@${range.start}-${range.start + range.length - 1}`;
  return dlFileUrl(id);
}

export type PieceFailureReason = "network" | "auth" | "dead" | "quota";

/**
 * What a failed piece means. 401/403 and signature errors are expired links,
 * not dead video. 404/410/416 are dead. 429/5xx and status 0 are the network.
 */
export function classifyPieceStatus(status: number, detail = ""): PieceFailureReason {
  const d = detail.toLowerCase();
  if (
    d.includes("bad signature") ||
    d.includes("token mint") ||
    d.includes("expired")
  ) {
    return "auth";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 410 || status === 416) return "dead";
  if (status === 429 || status === 408 || status === 0 || status >= 500) return "network";
  if (status >= 400) return "dead";
  return "network";
}

/** Timeouts and connection resets are retryable. User aborts are not (caller checks first). */
export function isTransientFetchError(errName: string, message = ""): boolean {
  if (errName === "TimeoutError" || errName === "TypeError") return true;
  return /failed to fetch|network error|stalled|timed out/i.test(message);
}

/** How many dead segments a title can skip before the mirror is abandoned. */
export function gapBudget(segmentCount: number): number {
  const n = Number.isFinite(segmentCount) && segmentCount > 0 ? segmentCount : 0;
  return Math.max(8, Math.ceil(n * 0.03));
}

/**
 * Piece decision used by the engine and the unit script.
 * `refresh` = expired link, refetch the playlist (never a gap).
 * `gap` = this segment is dead but the title can continue.
 * `fail` = stop this mirror (key/init, or gap cap).
 * `retry` = same URL, backoff.
 */
export function pieceOutcome(opts: {
  status: number;
  detail?: string;
  kind: "seg" | "key" | "init";
  /** True on the attempt after a playlist refresh. A repeat 403 is then a dead segment. */
  authAsDead?: boolean;
  gaps: number;
  segmentCount: number;
}): "retry" | "refresh" | "gap" | "fail" {
  const reason = classifyPieceStatus(opts.status, opts.detail ?? "");
  if (reason === "network") return "retry";
  if (reason === "quota") return "fail";
  if (reason === "auth" && !opts.authAsDead) return "refresh";
  if (opts.kind !== "seg") return "fail";
  if (opts.gaps >= gapBudget(opts.segmentCount)) return "fail";
  return "gap";
}

/** Quota, encryption, and "not in this quality" must not auto-loop. */
export function isHardDownloadError(message: string): boolean {
  return /out of device space|not enough device storage|free space or raise the cap|can't be saved offline|not available in|no playable quality|no downloadable stream|download mode is off|resolver/i.test(
    message
  );
}

function looksLikeText(bytes: Uint8Array): boolean {
  let i = 0;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    i = 3;
  }
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  ) {
    i++;
  }
  if (i >= bytes.length) return true;
  // "<" is HTML/XML. "{" / "[" only count when they look like JSON — a single
  // brace is a normal first byte of AES-128 ciphertext.
  if (bytes[i] === 0x3c) return true;
  if (bytes[i] === 0x7b || bytes[i] === 0x5b) {
    const next = bytes[i + 1];
    if (next === 0x22 || next === 0x0a || next === 0x0d || next === 0x20 || next === 0x7b) {
      return true;
    }
  }
  const n = Math.min(bytes.length, i + 7);
  let head = "";
  for (let j = i; j < n; j++) head += String.fromCharCode(bytes[j] ?? 0);
  return head.startsWith("#EXT");
}

function looksLikeFmp4(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const box = String.fromCharCode(
    bytes[4] ?? 0,
    bytes[5] ?? 0,
    bytes[6] ?? 0,
    bytes[7] ?? 0
  );
  return (
    box === "ftyp" ||
    box === "moof" ||
    box === "styp" ||
    box === "sidx" ||
    box === "moov" ||
    box === "mdat" ||
    box === "emsg" ||
    box === "free" ||
    box === "skip"
  );
}

/**
 * Reject empty bodies, playlists, HTML, and JSON stored as media.
 * Clear video must look like MPEG-TS or fMP4. AES-128 ciphertext has no
 * magic — only the text check applies. A prefix (first 256 bytes) is enough.
 */
export function segmentLooksValid(
  bytes: Uint8Array,
  kind: "seg" | "key" | "init",
  encrypted: boolean
): boolean {
  if (bytes.byteLength === 0) return false;
  if (looksLikeText(bytes)) return false;
  if (kind === "key") return bytes.byteLength === 16;
  if (encrypted) return bytes.byteLength >= 16;
  if (kind === "init") return looksLikeFmp4(bytes);
  if (bytes[0] === 0x47) return true;
  // ID3 tag ahead of the TS packets (common on HLS).
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  // Separate audio renditions are often ADTS AAC or AC-3, not TS/fMP4.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0) return true;
  if (bytes.length >= 2 && bytes[0] === 0x0b && bytes[1] === 0x77) return true;
  return looksLikeFmp4(bytes);
}

export function parseMediaPlaylist(text: string, baseUrl: string): MediaParts {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments: MediaSegment[] = [];
  const keys: { method: string; url: string }[] = [];
  const maps: MediaInit[] = [];
  let mapUrl: string | null = null;
  let durationSec = 0;
  let expectSegment = false;
  let sampleAes = false;
  let aes = false;
  let pendingRange: ByteRange | null = null;
  let prevRangeEnd = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      const br = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
      if (uri) {
        try {
          const url = new URL(uri, baseUrl).toString();
          const byteRange = br ? parseByteRangeSpec(br, 0) : null;
          maps.push({ url, byteRange });
          mapUrl = maps[0]?.url ?? url;
          if (byteRange) prevRangeEnd = byteRange.start + byteRange.length;
        } catch {
          /* ignore */
        }
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const method = /METHOD=([^,]+)/.exec(line)?.[1]?.trim() ?? "NONE";
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) {
        try {
          keys.push({ method, url: new URL(uri, baseUrl).toString() });
        } catch {
          /* ignore */
        }
      }
      if (method === "SAMPLE-AES") sampleAes = true;
      if (method === "AES-128") aes = true;
      else if (method === "NONE") aes = false;
    } else if (line.startsWith("#EXTINF:")) {
      durationSec += Number(line.slice(8).split(",")[0]) || 0;
      expectSegment = true;
      pendingRange = null;
    } else if (expectSegment && line.startsWith("#EXT-X-BYTERANGE")) {
      const spec = line.slice("#EXT-X-BYTERANGE:".length).trim();
      const parsed = parseByteRangeSpec(spec, prevRangeEnd);
      if (parsed) {
        pendingRange = parsed;
        prevRangeEnd = parsed.start + parsed.length;
      }
    } else if (expectSegment && line.startsWith("#")) {
      /* Tag between EXTINF and the URI (GAP, discontinuity). Keep waiting. */
    } else if (expectSegment) {
      expectSegment = false;
      if (line && !line.startsWith("#")) {
        try {
          segments.push({
            url: new URL(line, baseUrl).toString(),
            byteRange: pendingRange,
            encrypted: aes,
          });
        } catch {
          /* ignore */
        }
      }
      pendingRange = null;
    }
  }
  return {
    segments,
    mapUrl,
    maps,
    keys,
    durationSec,
    sampleAes,
    aes128: aes || segments.some((s) => s.encrypted),
  };
}

function withHlsVersion(text: string, min: number): string {
  const m = /#EXT-X-VERSION:(\d+)/.exec(text);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= min) return text;
    return text.replace(/#EXT-X-VERSION:\d+/, `#EXT-X-VERSION:${min}`);
  }
  if (/^#EXTM3U/.test(text)) {
    return text.replace(/^#EXTM3U[^\n]*\n?/, (lead) => {
      const trimmed = lead.endsWith("\n") ? lead.slice(0, -1) : lead;
      return `${trimmed}\n#EXT-X-VERSION:${min}\n`;
    });
  }
  return `#EXTM3U\n#EXT-X-VERSION:${min}\n${text}`;
}

function rewriteTaggedUri(rawLine: string, baseUrl: string): string {
  const br = /BYTERANGE="([^"]+)"/.exec(rawLine);
  const range = br ? parseByteRangeSpec(br[1] ?? "", 0) : null;
  let line = br ? rawLine.replace(/,?BYTERANGE="[^"]*"/, "") : rawLine;
  return line.replace(/URI="([^"]+)"/, (_m, uri: string) => {
    if (String(uri).startsWith("/api/dl?")) return `URI="${uri}"`;
    try {
      const abs = new URL(String(uri), baseUrl).toString();
      return `URI="${offlinePieceUrl(abs, range)}"`;
    } catch {
      return `URI="${uri}"`;
    }
  });
}

/**
 * Rewrite a media playlist so every segment / init / key URI points at the
 * offline serve path. Byte-range slices are stored as their own files, so
 * the BYTERANGE tag is removed. Dead segments become `#EXT-X-GAP` and the
 * playlist version is raised to 8 (players that ignore GAP would 404).
 * Already-offline URLs pass through untouched.
 */
export function rewritePlaylistForOffline(
  text: string,
  baseUrl: string,
  gaps: ReadonlySet<string> = new Set()
): string {
  const lines = text.split(/\r?\n/);
  let expectSegment = false;
  let pendingRange: ByteRange | null = null;
  let prevRangeEnd = 0;
  let sawGap = false;
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-MAP:") || line.startsWith("#EXT-X-KEY:")) {
      out.push(rewriteTaggedUri(rawLine, baseUrl));
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      expectSegment = true;
      pendingRange = null;
      out.push(rawLine);
      continue;
    }
    if (expectSegment && line.startsWith("#EXT-X-BYTERANGE")) {
      const parsed = parseByteRangeSpec(
        line.slice("#EXT-X-BYTERANGE:".length).trim(),
        prevRangeEnd
      );
      if (parsed) {
        pendingRange = parsed;
        prevRangeEnd = parsed.start + parsed.length;
      }
      // Slice is stored whole — the offline playlist must not ask for a range.
      continue;
    }
    if (expectSegment && line.startsWith("#")) {
      out.push(rawLine);
      continue;
    }
    if (expectSegment) {
      expectSegment = false;
      if (line && !line.startsWith("#")) {
        if (line.startsWith("/api/dl?")) {
          out.push(rawLine);
        } else {
          try {
            const abs = new URL(line, baseUrl).toString();
            const rewritten = offlinePieceUrl(abs, pendingRange);
            if (gaps.has(rewritten)) {
              sawGap = true;
              out.push("#EXT-X-GAP");
            }
            out.push(rewritten);
          } catch {
            out.push(rawLine);
          }
        }
      } else {
        out.push(rawLine);
      }
      pendingRange = null;
      continue;
    }
    out.push(rawLine);
  }
  const joined = out.join("\n");
  return sawGap ? withHlsVersion(joined, 8) : joined;
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
