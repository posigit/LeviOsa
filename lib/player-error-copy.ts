export type StreamErrorInfo = {
  code?: string;
  detail?: string;
  message?: string;
  resolverConfigured?: boolean;
  /** Per-source attempts — lets the title detect the real status (404 etc.). */
  attempts?: Array<{ source: string; ok?: boolean; error?: string }>;
} | null;

/**
 * Friendly error title from the structured resolve failure (codes beat
 * guessing). Offline keeps its download-specific copy.
 */
export function streamErrorCopy(
  offlineOverride: boolean,
  streamError: StreamErrorInfo
): { title: string; detail: string } {
  const attemptText = (streamError?.attempts ?? [])
    .filter((a) => !a.ok)
    .map((a) => a.error ?? "")
    .join(" ");
  const text = `${streamError?.code ?? ""} ${streamError?.message ?? ""} ${attemptText}`;
  const title = offlineOverride
    ? "Couldn't play this download"
    : streamError?.resolverConfigured === false
      ? "Streaming server not set up"
      : /403|forbidden|blocked/i.test(text)
        ? "Source blocked on this network"
        : /timeout|timed out|504|522|524/i.test(text)
          ? "Source timed out"
          : /404|not.?found|no sources|no streams/i.test(text)
            ? "Not available on this source"
            : "Player unavailable here";
  const detail = offlineOverride
    ? "The saved file may be incomplete — try downloading it again."
    : streamError?.detail ||
      streamError?.message ||
      "Try switching to another source.";
  return { title, detail };
}
