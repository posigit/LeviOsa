/**
 * Rendition signatures for the engine's guard against splicing two
 * different cuts of a video into one offline file.
 *
 * Storage pieces are keyed by position (`idx:{key}:{role}:{index}`), so a
 * later attempt hits whatever sits at the same index regardless of what
 * produced it. When the upstream playlist changes, the guard must drop
 * exactly the pieces that could belong to the old cut and keep the rest:
 * an audio-track flap must not throw away paid-for video, a variant drift
 * must not throw away a matching audio rendition, and a source change must
 * trust nothing at all. Pure (no storage, no network) — unit-tested in
 * scripts/test-offline-download.ts.
 */

export type MediaGroup = "video" | "audio" | "subs";

/** Piece roles owned by each group (role shapes from segmentIndexUrl). */
export const GROUP_ROLES: Record<MediaGroup, readonly string[]> = {
  video: ["v", "vi", "vk"],
  audio: ["a", "ai", "ak"],
  subs: ["s", "si", "sk"],
};

/** The bare (segment, not init/key) role of each group. */
const SEGMENT_ROLE: Record<MediaGroup, string> = {
  video: "v",
  audio: "a",
  subs: "s",
};

/**
 * Encode the current parse into a stored signature. Video carries its
 * height — a variant change alters every byte — while audio and subs only
 * carry their segment count (they have no height of their own).
 */
export function encodeRendition(
  video: string,
  audio: string,
  subs: string
): string {
  return `${video}|${audio}|${subs}`;
}

export type RenditionPlan = {
  /** Groups whose stored pieces must be dropped (empty = keep everything). */
  groups: MediaGroup[];
  /** False when the record carries no signature yet (first attempt). */
  hadStored: boolean;
};

/**
 * Decide which piece groups a new parse invalidates. The stored signature
 * may be the legacy `height:videoCount:audioCount` form (no subs field) —
 * subs are then unknown and drop, which costs a caption track's bytes at
 * most. Equal signatures with the same source keep everything.
 */
export function planRenditionWipe(opts: {
  stored: string | null | undefined;
  next: string;
  sourceChanged: boolean;
}): RenditionPlan {
  const { stored, next, sourceChanged } = opts;
  if (!stored) return { groups: [], hadStored: false };
  // A different source serves a different copy of the title: counts and
  // heights can coincide, so no stored piece is provably the same bytes.
  if (sourceChanged) {
    return { groups: ["video", "audio", "subs"], hadStored: true };
  }
  const old = parseStored(stored);
  const [nextVideo, nextAudio, nextSubs] = next.split("|");
  const groups: MediaGroup[] = [];
  if (old.video !== (nextVideo ?? "")) groups.push("video");
  if (old.audio !== (nextAudio ?? "")) groups.push("audio");
  // Unknown subs never match: drop rather than risk stale caption positions.
  if (old.subs == null || old.subs !== (nextSubs ?? "")) groups.push("subs");
  return { groups, hadStored: true };
}

function parseStored(stored: string): {
  video: string;
  audio: string;
  subs: string | null;
} {
  if (stored.includes("|")) {
    const [video, audio, subs] = stored.split("|");
    return { video: video ?? "", audio: audio ?? "", subs: subs ?? null };
  }
  // Legacy `height:videoCount:audioCount` — no subs field was tracked.
  const parts = stored.split(":");
  if (parts.length === 3) {
    return { video: `${parts[0]}:${parts[1]}`, audio: parts[2]!, subs: null };
  }
  return { video: stored, audio: "", subs: null };
}

export type PieceInfo = {
  group: MediaGroup;
  role: string;
  isSegment: boolean;
};

/**
 * Classify a stored piece URL (`/api/dl?u=idx:{key}:{role}:{index}`).
 * Returns null for record-level pieces (top playlist, `vp`/`ap`/`sp`
 * sub-playlists) and legacy origin-keyed entries — the wipe keeps those:
 * playlists are rewritten from the fresh parse at the end of every attempt
 * and legacy entries are content-addressed by their origin URL.
 */
export function pieceInfo(url: string): PieceInfo | null {
  let canonical: string | null = null;
  try {
    canonical = new URL(url, "http://localhost").searchParams.get("u");
  } catch {
    return null;
  }
  if (!canonical || !canonical.startsWith("idx:")) return null;
  const parts = canonical.split(":");
  const role = parts[parts.length - 2];
  const index = parts[parts.length - 1];
  if (!role || !index || !/^\d+$/.test(index)) return null;
  for (const group of ["video", "audio", "subs"] as const) {
    if (GROUP_ROLES[group].includes(role)) {
      return { group, role, isSegment: role === SEGMENT_ROLE[group] };
    }
  }
  return null;
}
