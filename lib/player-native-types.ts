/** Safari-only audio-track API — not present in TS's DOM lib. */
export type NativeAudioTrack = { language: string; enabled: boolean };
export type NativeAudioTrackList = {
  length: number;
  [index: number]: NativeAudioTrack;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

export type PlayerMode = "loading" | "native" | "iframe" | "error";

export type StreamSource =
  | "vix"
  | "goated"
  | "vidsrc-sh"
  | "vidfast"
  | "vidlink"
  | "vidnest"
  | "cinesrc"
  | "2embed"
  | "mapple"
  | "vidapi"
  | "ythd"
  | "xpass";

export type AudioTrackInfo = { id: number; lang: string; name: string };
export type QualityLevelInfo = { height: number; index: number };
