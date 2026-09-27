/**
 * BACKWARD-COMPAT SHIM — do not add code here.
 *
 * The download engine lives in lib/offline/engine.ts now. This module
 * re-exports the old surface so existing imports keep working.
 */

export {
  cancelDownload,
  deleteDownload,
  isDownloadActive,
  isDownloadQueued,
  pauseDownload,
  resumeDownload,
  startDownload,
  type DownloadRequest,
} from "@/lib/offline/engine";
