/**
 * BACKWARD-COMPAT SHIM — do not add code here.
 *
 * The offline stack lives in lib/offline/ now:
 *   store.ts  — manifest, storage accounting, positions, sync outbox
 *   hls.ts    — canonical keys, playlist parse/rewrite, variant picking
 *   engine.ts — download run/pause/resume/cancel
 * This module re-exports the old surface so existing imports keep working.
 */

export {
  DL_CACHE,
  commitRecord,
  deleteRecordFiles,
  downloadKey,
  ensurePersisted,
  getAllSync,
  getManifest,
  getRecordSync,
  isPlaybackInUse,
  missingCount,
  removeRecord,
  setPlaybackInUse,
  storageStats,
  subscribeDownloads,
  touchRecord,
  updateProgress,
  upsertRecord,
  usedBytes,
  verifyRecordFiles,
  clearOfflinePosition,
  readOfflinePosition,
  writeOfflinePosition,
  coalesceOutbox,
  drainPlaybackOutbox,
  enqueuePlayback,
  initPlaybackOutbox,
  isPermanentFailure,
  type DownloadItemType,
  type DownloadRecord,
  type DownloadState,
  type OfflinePosition,
  type OutboxEntry,
} from "@/lib/offline/store";
export {
  buildOfflineMaster,
  canonicalMediaKey,
  dlFileUrl,
  dlPlaylistUrl,
  estimateBytes,
  isMasterPlaylist,
  parseMasterAudio,
  parseMasterVariants,
  parseMediaPlaylist,
  pickAudioEntry,
  pickVariant,
  rewritePlaylistForOffline,
  VOLATILE_PARAMS,
  type AudioEntry,
  type MediaParts,
  type VariantInfo,
} from "@/lib/offline/hls";
export { formatBytes } from "@/lib/utils";
