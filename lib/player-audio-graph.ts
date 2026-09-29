import type { MutableRefObject } from "react";

/** Permanent teardown for a WebAudio graph slot (unmount only). */
export function destroyAudioGraph(
  slot: MutableRefObject<{
    ctx: AudioContext;
    gain: GainNode;
  } | null>
): void {
  const g = slot.current;
  slot.current = null;
  if (!g) return;
  try {
    g.gain.disconnect();
  } catch {
    /* already torn down */
  }
  try {
    void g.ctx.close().catch(() => {});
  } catch {
    /* already closed */
  }
}
