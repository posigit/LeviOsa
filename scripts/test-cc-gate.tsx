/**
 * CC-menu gating for iframe sources.
 *
 * Regression guard: Vidy/VidStuck/VidZee shipped on a hardcoded iframe
 * allowlist that missed them — the CC button never rendered, so external
 * subtitles were unreachable ("stuck like CC"). Every clock-tracked embed
 * (driven OR passive) must render CC; a source whose clock we can't follow
 * must not, because its overlay cues could never sync.
 *
 * Run: npx tsx scripts/test-cc-gate.tsx
 */
import assert from "node:assert/strict";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlayerTopChrome } from "../components/player-top-chrome";
import { DEFAULT_VIX_SETTINGS } from "../lib/vix-settings";
import { isSubProviderLocked } from "../lib/player-subs";
import type { SubSource } from "../lib/player-subs";

type Props = ComponentProps<typeof PlayerTopChrome>;

const noop = () => {};

function render(patch: Partial<Props>): string {
  const props: Props = {
    title: "Fight Club",
    mode: "iframe",
    activeSource: "vidy",
    streamable: true,
    videoFit: DEFAULT_VIX_SETTINGS.videoFit,
    embedZoom: DEFAULT_VIX_SETTINGS.embedZoom,
    onCycleScreenFill: noop,
    audioTracks: [],
    audioTrackId: 0,
    audioMenuOpen: false,
    setAudioMenuOpen: noop,
    qualityLevels: [],
    qualitySelection: "auto",
    qualityMenuOpen: false,
    setQualityMenuOpen: noop,
    subSource: "auto",
    subMenuOpen: false,
    setSubMenuOpen: noop,
    onSubSource: noop,
    openSubItems: [],
    openSubFileId: null,
    openSubListLoading: false,
    onOpenSubPick: noop,
    savedSubAlts: [],
    savedSubAltIndex: null,
    onSavedSubAltPick: noop,
    hasExternalSubs: false,
    subDelay: 0,
    onAdjustSubDelay: noop,
    subFontSize: DEFAULT_VIX_SETTINGS.subFontSize,
    subColor: DEFAULT_VIX_SETTINGS.subColor,
    subBgOpacity: DEFAULT_VIX_SETTINGS.subBgOpacity,
    subBgBlur: DEFAULT_VIX_SETTINGS.subBgBlur,
    onPatchSubStyle: noop,
    subError: null,
    onPickSource: noop,
    sourceOptions: ["vidy"],
    onLock: noop,
    onClose: noop,
    onKeepChrome: noop,
    subMenuRef: { current: null },
    audioMenuRef: { current: null },
    qualityMenuRef: { current: null },
    setHlsAudioTrackRef: { current: null },
    setHlsQualityRef: { current: null },
    ...patch,
  };
  return renderToStaticMarkup(<PlayerTopChrome {...props} />);
}

const hasCC = (html: string) => html.includes('aria-label="Subtitles"');

// Clock-tracked iframe sources (driven + passive) all get the CC menu.
for (const activeSource of [
  "vidy",
  "vidstuck",
  "vidzee",
  "mapple",
  "vidlink",
  "vidnest",
  "2embed",
  "cinesrc",
  "vidfast",
] as const) {
  assert.equal(
    hasCC(render({ activeSource, clockEmbed: true })),
    true,
    `${activeSource} with a tracked clock must render CC`
  );
}

// No clock -> no CC: the overlay could never sync external cues.
assert.equal(
  hasCC(render({ activeSource: "vix", clockEmbed: false })),
  false,
  "a source without a tracked clock must not render CC"
);
assert.equal(
  hasCC(render({ activeSource: "vidy", clockEmbed: false })),
  false,
  "clockEmbed=false must suppress CC even for clock-capable sources"
);

// Native mode always renders CC, flag or not.
assert.equal(
  hasCC(render({ mode: "native", activeSource: "vidy", clockEmbed: false })),
  true,
  "native mode must render CC"
);

// Offline CC: network file providers lock only when nothing stored can
// play. Picking one offline otherwise dies in a fetch → revert-to-Auto
// loop (the row flips back to Auto by itself).
const providers: SubSource[] = ["vdrk", "opensub", "subdl"];
const local: SubSource[] = ["auto", "stream", "off"];
for (const key of providers) {
  assert.equal(
    isSubProviderLocked(false, false, key),
    true,
    `offline with no stored track must lock ${key}`
  );
  assert.equal(
    isSubProviderLocked(true, false, key),
    false,
    `online download viewing must keep ${key} (fetches work)`
  );
  assert.equal(
    isSubProviderLocked(false, true, key),
    false,
    `stored track playing must keep ${key} (spares switch locally)`
  );
}
for (const key of local) {
  assert.equal(
    isSubProviderLocked(false, false, key),
    false,
    `offline must never lock ${key} (needs no network)`
  );
}

// Saved spares render whenever they exist — even on Auto — so the offline
// switcher is discoverable without first picking a network provider.
const offlineMenu = (patch: Partial<Props>): string =>
  render({
    mode: "native",
    subMenuOpen: true,
    subSource: "auto",
    ...patch,
  });
assert.equal(
  offlineMenu({
    savedSubAlts: [{ label: "English (OpenSubs)" }],
    savedSubAltIndex: null,
  }).includes("Saved files"),
  true,
  "stored spares must show on Auto, not just on opensub/subdl"
);
assert.equal(
  offlineMenu({ savedSubAlts: [], savedSubAltIndex: null }).includes(
    "Saved files"
  ),
  false,
  "no spares means no Saved files section"
);

console.log("cc-gate: all assertions passed");
