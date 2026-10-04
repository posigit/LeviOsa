/**
 * Render smoke tests for the new player surfaces (P0/P1/P2 batch):
 * loading splash, pause card, tip line, skip cue, grouped settings drawer,
 * error card hint, and the Up Next toast.
 *
 * Guards the invariants the batch must not regress: the splash is inert
 * (pointer-events-none) so it can never eat a tap, the pause card never
 * leaks below its z-index, the Up Next card stays bottom-right with a 10s
 * countdown, and the drawer/error cards expose their labels for a11y.
 *
 * Run: npx tsx scripts/test-player-surfaces.tsx
 */
import assert from "node:assert/strict";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LoadingSplash,
  PausedInfoLayer,
  TapCue,
  TipLine,
  PLAYER_TIPS,
} from "../components/player-overlays";
import { PlayerSettingsPanel } from "../components/player-settings-panel";
import { PlayerErrorOverlay } from "../components/player-error-overlay";
import { UpNextCard } from "../components/up-next-card";
import { sourceLabel } from "../lib/embed-sources";

// SSR reads `useOnline()` from navigator.onLine; Node's navigator ships none,
// which would mark every source row "Offline" and hide the labels under test.
try {
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
} catch {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true },
    configurable: true,
  });
}

const noop = () => {};
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

// ---------- Loading splash ----------
const splash = html(
  <LoadingSplash label="Loading Vid" eyebrow="Resolving source" />
);
assert.match(splash, /pointer-events-none/, "splash must never eat taps");
assert.match(splash, /player-scan/, "splash must carry the scan line");
assert.match(splash, /Resolving source/, "splash eyebrow must render");
assert.match(splash, /Loading Vid/, "splash label must render");
assert.doesNotMatch(
  splash,
  /z-\[6\]|z-40|z-50/,
  "splash must sit under the controls and overlays"
);

// ---------- Pause card ----------
const pauseInfo = {
  year: 1999,
  runtime: 139,
  rating: 8.7,
  genres: ["Drama", "Crime"],
  overview:  "An insomniac office worker and a devil-may-care soap maker form an underground fight club.",
};
const pauseCard = html(
  <PausedInfoLayer title="Fight Club" info={pauseInfo} />
);
assert.match(pauseCard, /Paused/, "pause card needs its eyebrow");
assert.match(pauseCard, /Fight Club/, "pause card needs the title");
assert.match(pauseCard, /1999/, "pause card needs the year");
assert.match(pauseCard, /2h 19m/, "pause card needs the runtime");
assert.match(pauseCard, /★ 8\.7/, "pause card needs the rating");
assert.match(pauseCard, /Drama/, "pause card needs genre chips");
assert.match(pauseCard, /line-clamp-3/, "overview must clamp, not flood");
assert.match(pauseCard, /rgb\(var\(--theme, 245 197 24\) \/ 0\.95\)/, "accent must be theme-tinted with a gold fallback");
assert.match(pauseCard, /z-\[4\]/, "pause card stays under the error card (z-6)");

// No metadata (host without it) still renders a usable card — just slimmer.
const barePauseCard = html(<PausedInfoLayer title="Some Show" info={null} />);
assert.match(barePauseCard, /Some Show/, "bare pause card keeps the title");
assert.doesNotMatch(barePauseCard, /1999/, "bare pause card hides absent meta");

// ---------- Tip line ----------
const tip = html(<TipLine />);
assert.match(tip, /Tip/, "tip line needs its label");
assert.ok(
  PLAYER_TIPS.some((t) => tip.includes(t)),
  "a tip from the pool must render on mount"
);
assert.ok(PLAYER_TIPS.length >= 8, "tip rotation needs a real pool");

// ---------- Skip cue ----------
const cueRight = html(<TapCue side="right" />);
assert.match(cueRight, /10s/, "cue must name the skip length");
assert.match(
  cueRight,
  /Skipped forward 10 seconds/,
  "cue keeps its accessible name"
);
assert.match(cueRight, /player-skip/, "cue must animate");
const cueLeft = html(<TapCue side="left" />);
assert.match(cueLeft, /Skipped back 10 seconds/, "left cue names the direction");

// ---------- Settings drawer (one render per tab — tabs are internal state) ----------
const drawerProps: ComponentProps<typeof PlayerSettingsPanel> = {
  open: true,
  onClose: noop,
  mode: "native",
  activeSource: "vix",
  sourceOptions: ["vix", "vidfast", "goated"],
  disabledSources: ["goated"],
  failedSourceLabels: [sourceLabel("vidfast")],
  streamable: true,
  onPickSource: noop,
  videoFit: "fit",
  embedZoom: 1,
  onCycleScreenFill: noop,
  brightness: 1,
  onBrightness: noop,
  mirrored: false,
  onToggleMirror: noop,
  playbackSpeed: 1,
  onPickSpeed: noop,
  loopOn: false,
  onToggleLoop: noop,
};
const drawer =
  html(<PlayerSettingsPanel {...drawerProps} />) +
  html(<PlayerSettingsPanel {...drawerProps} initialTab="media" />) +
  html(<PlayerSettingsPanel {...drawerProps} initialTab="playback" />);
for (const tab of ["Source", "Media", "Playback"]) {
  assert.match(drawer, new RegExp(tab), `drawer must expose the ${tab} tab`);
}
assert.match(drawer, /Down/, "parked source keeps its outage label");
assert.match(drawer, /Failed/, "streak failures must be visible before a re-pick");
assert.match(drawer, /Playing/, "live source is marked playing");
assert.match(drawer, /Mirror picture/, "mirror toggle lives in the drawer");
assert.match(drawer, /Loop/, "loop toggle lives in the drawer");
assert.match(drawer, /Brightness|Screen fill/, "picture controls live in the drawer");
assert.match(drawer, /session only|Session/i, "drawer must warn that loop is session-only");

// ---------- Error card ----------
const errorCard = html(
  <PlayerErrorOverlay
    title="This stream failed"
    detail="Every mirror refused the request."
    canRetry
    showTryNext
    tryNextLabel="VidFast"
    attempts={[{ source: "Vix", ok: false, error: "404" }]}
    onReveal={noop}
    onRetry={noop}
    onClose={noop}
    onTryNext={noop}
  />
);
assert.match(errorCard, /This stream failed/, "error card keeps its title");
assert.match(errorCard, /Vix ✗ 404/, "error card shows the failure trail");
assert.match(errorCard, /Try VidFast/, "error card offers the next server");
assert.match(errorCard, /Source<\/span> \(top-left\)/, "error card carries the recovery hint");

// ---------- Up Next toast ----------
const upNext = html(
  <UpNextCard
    episode={{
      title: "The one with the pivot",
      seasonNumber: 2,
      episodeNumber: 7,
      stillPath: null,
    }}
    currentSeason={2}
    countdown={10}
    onPlay={noop}
    onCancel={noop}
    showTitle="Friends"
  />
);
assert.match(upNext, /justify-end/, "Up Next stays bottom-right");
assert.match(upNext, /bottom-0/, "Up Next stays anchored to the bottom");
assert.match(upNext, /Starts in 10s/, "countdown still starts at 10s");
assert.match(upNext, /z-40/, "Up Next stays above the pause card");
assert.match(upNext, /var\(--theme/, "Up Next borrows the title accent");

console.log("player-surfaces: all assertions passed");
