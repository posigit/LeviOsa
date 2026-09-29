import { LoaderCircle, Lock } from "lucide-react";

type UnlockButtonProps = {
  onUnlock: () => void;
};

export function UnlockButton({ onUnlock }: UnlockButtonProps) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      aria-label="Unlock player controls"
      className="absolute right-4 top-4 z-40 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur transition hover:bg-black/80"
    >
      <Lock className="h-5 w-5" />
    </button>
  );
}

type TapCueProps = {
  side: "left" | "right";
};

export function TapCue({ side }: TapCueProps) {
  return (
    <div
      role="status"
      aria-label={
        side === "right"
          ? "Skipped forward 10 seconds"
          : "Skipped back 10 seconds"
      }
      className={`pointer-events-none absolute inset-y-0 z-40 flex items-center ${
        side === "right" ? "justify-end pr-6" : "justify-start pl-6"
      }`}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-lg font-bold text-white backdrop-blur">
        {side === "right" ? "+10" : "−10"}
      </span>
    </div>
  );
}

export function LoadingPill({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center text-white/70">
      <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-xs font-semibold backdrop-blur">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {label}
      </div>
    </div>
  );
}

/**
 * Rebuffer spinner only once playback has started — centered above the
 * picture, never over the Play control (it sits at z-30 vs the transport's
 * z-20, so a spinner while paused would swallow the tap).
 */
export function BufferingSpinner() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60 backdrop-blur">
        <LoaderCircle className="h-5 w-5 animate-spin text-white/85" />
      </span>
    </div>
  );
}
