type PlayerErrorOverlayProps = {
  title: string;
  detail: string;
  canRetry: boolean;
  showTryNext: boolean;
  tryNextLabel: string;
  onRetry: () => void;
  onClose: () => void;
  onTryNext: () => void;
};

export function PlayerErrorOverlay({
  title,
  detail,
  canRetry,
  showTryNext,
  tryNextLabel,
  onRetry,
  onClose,
  onTryNext,
}: PlayerErrorOverlayProps) {
  return (
    <div className="absolute inset-0 z-[6] flex items-center justify-center bg-black/85 p-6 text-center">
      <div>
        <p className="font-bold text-white">{title}</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-white/55">{detail}</p>
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
      </div>
    </div>
  );
}
