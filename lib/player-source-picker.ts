import { EMBED_SOURCES } from "@/lib/embed-sources";
import type { StreamSource } from "@/lib/player-native-types";

// Picker order: cinesrc, vidfast, mapple, vidlink, vidnest, 2embed,
// vidapi, then vix. Goated is parked (backend DNS dead 2026-09-23) —
// swap GOATED_RESOLVER in lib/goated.ts to resurrect.
export const ALL_SOURCES: StreamSource[] = [
  ...EMBED_SOURCES.map((s) => s.key as StreamSource),
  "vix",
  "goated",
];

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
