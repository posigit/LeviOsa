type PlayerErrorOverlayProps = {
  title: string;
  detail: string;
  canRetry: boolean;
  showTryNext: boolean;
  tryNextLabel: string;
  /** Failed resolve attempts — shown as "source ✗ status" lines. */
  attempts?: Array<{ source: string; ok?: boolean; error?: string }>;
  /** Tapping the card (not a button) brings the controls back — the hint line
   *  sends people to the Source pill, which lives in the top chrome and may
   *  have auto-hidden. `onPointerDown`, not onClick: no keyboard/role needed
   *  for a backdrop, and the buttons above stop being "surprises" (their own
   *  handlers still win — the reveal is harmless either way). */
  onReveal?: () => void;
  onRetry: () => void;
  onClose: () => void;
  onTryNext: () => void;
};

function attemptStatus(error?: string): string {
  const m = /\b([45]\d{2})\b/.exec(error ?? "");
  return m ? m[1] : "failed";
}

export function PlayerErrorOverlay({
  title,
  detail,
  canRetry,
  showTryNext,
  tryNextLabel,
  attempts,
  onReveal,
  onRetry,
  onClose,
  onTryNext,
}: PlayerErrorOverlayProps) {
  const failed = (attempts ?? []).filter((a) => !a.ok);
  return (
    <div
      className="absolute inset-0 z-[6] flex items-center justify-center bg-black/85 p-6 text-center"
      onPointerDown={onReveal}
    >
      <div>
        <p className="font-bold text-white">{title}</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-white/55">{detail}</p>
        {failed.length > 0 && (
          <div className="mx-auto mt-2 space-y-0.5">
            {failed.map((a, i) => (
              <p key={`${a.source}-${i}`} className="font-mono text-xs text-white/45">
                {a.source} ✗ {attemptStatus(a.error)}
              </p>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-center gap-2">
          {canRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center rounded-full bg-white/10 px-4 py-2 text-sm font-bold text-white ring-1 ring-white/20 transition hover:bg-white/20"
            >
              Retry
            </button>
          )}
          {!canRetry && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center rounded-full bg-white/10 px-4 py-2 text-sm font-bold text-white ring-1 ring-white/20 transition hover:bg-white/20"
            >
              Close
            </button>
          )}
          {showTryNext && (
            <button
              type="button"
              onClick={onTryNext}
              className="inline-flex items-center rounded-full bg-primary px-4 py-2 text-sm font-bold text-black"
            >
              Try {tryNextLabel}
            </button>
          )}
        </div>
        <p className="mx-auto mt-3 max-w-[19rem] text-xs leading-relaxed text-white/45">
          Tip: tap the frame to bring the controls back, then{" "}
          <span className="font-semibold text-white/70">Source</span> (top-left)
          switches server — your place is kept.
        </p>
      </div>
    </div>
  );
}
