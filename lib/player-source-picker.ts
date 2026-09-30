import { EMBED_SOURCES } from "@/lib/embed-sources";
import type { StreamSource } from "@/lib/player-native-types";

// Picker order (user-ranked, 2026-09-30): vidy, vidstuck, cinesrc, vidsrc-sh,
// vix, mapple, vidzee, vidfast, vidlink, vidnest, 2embed, vidapi, goated.
// Written out explicitly now that native sources sit *between* embeds (the
// old slice trick only ever spliced vidsrc-sh in). XPass + YTHD were dropped
// from the picker the same day. Goated is parked (backend DNS dead
// 2026-09-23) — swap GOATED_RESOLVER in lib/goated.ts to resurrect.
const EMBED_KEYS = new Set(EMBED_SOURCES.map((s) => s.key));

export const ALL_SOURCES: StreamSource[] = [
  "vidy",
  "vidstuck",
  "cinesrc",
  "vidsrc-sh",
  "vix",
  "mapple",
  "vidzee",
  "vidfast",
  "vidlink",
  "vidnest",
  "2embed",
  "vidapi",
  "goated",
];

// Registry drift guard: every embed key must appear in the picker exactly
// once, and no picker entry may be an unknown embed key. Runs in dev/test.
if (process.env.NODE_ENV !== "production") {
  const listed = ALL_SOURCES.filter((k) => EMBED_KEYS.has(k));
  const missing = [...EMBED_KEYS].filter((k) => !listed.includes(k as StreamSource));
  if (missing.length > 0) {
    console.error("[player-source-picker] embed keys missing from ALL_SOURCES:", missing);
  }
}

export function disabledSourcesFor(
  type: "movie" | "tv" | undefined
): StreamSource[] {
  return [
    "goated",
    ...(type === "tv"
      ? EMBED_SOURCES.filter((s) => !s.tvUrl(0, 1, 1)).map(
          (s) => s.key as StreamSource
        )
      : []),
  ];
}

export function nextPlayableSource(
  current: StreamSource,
  disabledSources: Iterable<StreamSource>
): StreamSource {
  const blocked = new Set(disabledSources);
  const start = ALL_SOURCES.indexOf(current);
  for (let i = 1; i <= ALL_SOURCES.length; i++) {
    const next = ALL_SOURCES[(start + i) % ALL_SOURCES.length];
    if (next && !blocked.has(next)) return next;
  }
  return current;
}
