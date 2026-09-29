/**
 * Embed-source registry for the player's iframe fallback.
 *
 * Picker order: cinesrc, vidfast, mapple, vidlink, vidnest, 2embed, vidapi,
 * ythd, xpass.
 * Native vix + goated are appended in vix-player (goated parked: backend down).
 * Mapple + VidFast + VidLink post PLAYER_EVENT (progress saves); VidFast also
 * accepts {command} control messages. CineSrc posts cinesrc:* events, not
 * PLAYER_EVENT — vix-player adapts those. VidAPI posts PLAYER_EVENT in its own
 * shape ({player_status, player_progress}) — adapted in vix-player. CineSrc
 * embeds use controls=false and VidNest embeds hide their transport chrome by
 * query param, so lock mode cannot leak embed chrome (host chrome +
 * postMessage instead). VidAPI/Mapple/VidLink/2Embed keep their own chrome;
 * the host only syncs progress for those.
 */
export type EmbedSourceDef = {
  /** Stable key — persisted as preferredSource. */
  key: string;
  /** Display name for the picker. */
  name: string;
  /** Base origin, e.g. https://vidfast.vc */
  base: string;
  /** Hostname the player frames post messages from. */
  host: string;
  /** Build a movie embed URL. */
  movieUrl: (tmdbId: number) => string;
  /** Build a TV embed URL. */
  tvUrl: (tmdbId: number, season: number, episode: number) => string;
  /**
   * Iframe referrer policy override. Default (omitted) is "no-referrer"
   * (strips Vercel/app origins that trip source WAFs). Sources whose player
   * refuses an empty referrer set "origin". One-line flip per source.
   */
  referrerPolicy?: "no-referrer" | "origin";
};

export const EMBED_SOURCES: EmbedSourceDef[] = [
  // Driven first: CineSrc + VidFast are popup-proof (tap-catcher owns all
  // taps, their ads never see a gesture) and get host transport + subs.
  // Raw embeds after them can still pop scam tabs on tap — no sandbox is
  // possible (sources wall on it), so ranking is the defense.
  {
    key: "cinesrc",
    name: "CineSrc",
    base: "https://cinesrc.st",
    host: "cinesrc.st",
    movieUrl: (tmdbId) =>
      `https://cinesrc.st/embed/movie/${tmdbId}?controls=false`,
    // TV is query-string; posts cinesrc:* events (adapted in vix-player).
    tvUrl: (tmdbId, season, episode) =>
      `https://cinesrc.st/embed/tv/${tmdbId}?s=${season}&e=${episode}&controls=false`,
  },
  {
    key: "vidfast",
    name: "VidFast",
    base: "https://vidfast.vc",
    host: "vidfast.vc",
    // Host-driven like CineSrc (tap-catcher owns taps, our transport owns
    // play/seek/volume via the command channel): hide its title overlay and
    // internal next/auto-next so only our chrome and Up Next advance episodes.
    movieUrl: (tmdbId) => `https://vidfast.vc/movie/${tmdbId}?autoPlay=true&title=false&poster=true`,
    tvUrl: (tmdbId, season, episode) =>
      `https://vidfast.vc/tv/${tmdbId}/${season}/${episode}?autoPlay=true&title=false&poster=true&nextButton=false&autoNext=false`,
  },
  {
    key: "mapple",
    name: "Mapple",
    base: "https://mapple.rip",
    host: "mapple.rip",
    // Official endpoints are mapple.rip/watch/... (mapple.tv is the landing
    // site). Events post from the mapple.rip origin — see LEGACY list below.
    movieUrl: (tmdbId) =>
      `https://mapple.rip/watch/movie/${tmdbId}?autoPlay=true`,
    tvUrl: (tmdbId, season, episode) =>
      `https://mapple.rip/watch/tv/${tmdbId}-${season}-${episode}?autoPlay=true`,
  },
  {
    key: "vidlink",
    name: "VidLink",
    base: "https://vidlink.pro",
    host: "vidlink.pro",
    movieUrl: (tmdbId) => `https://vidlink.pro/movie/${tmdbId}?autoplay=true&title=true&poster=true`,
    tvUrl: (tmdbId, season, episode) =>
      `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}?autoplay=true&title=true&poster=true&nextbutton=true`,
  },
  {
    key: "vidnest",
    name: "VidNest",
    base: "https://vidnest.fun",
    host: "vidnest.fun",
    // Hide the embed's transport chrome (slider/center play/±seek) so lock
    // mode cannot leak it. Captions/settings/fullscreen stay usable.
    // TV resumes via `progress`, movies via `startAt` (see addStartAt).
    movieUrl: (tmdbId) =>
      `https://vidnest.fun/movie/${tmdbId}?timeslider=hide&centerplay=hide&centerseekbackward=hide&centerseekforward=hide`,
    tvUrl: (tmdbId, season, episode) =>
      `https://vidnest.fun/tv/${tmdbId}/${season}/${episode}?timeslider=hide&centerplay=hide&centerseekbackward=hide&centerseekforward=hide`,
  },
  {
    key: "2embed",
    name: "2Embed",
    base: "https://www.2embed.cc",
    host: "2embed.cc",
    // /embed/ is the player; /movie/{id} is a wrapper landing page.
    movieUrl: (tmdbId) => `https://www.2embed.cc/embed/${tmdbId}`,
    tvUrl: (tmdbId, season, episode) =>
      `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`,
  },
  {
    key: "vidapi",
    name: "VidAPI",
    base: "https://vaplayer.ru",
    host: "vaplayer.ru",
    // Documented params (vidapi.to/api): autoplay, showTitle, resumeAt,
    // sub_url, ds_lang. No inbound command channel, so like Mapple the
    // embed keeps its chrome and the host only syncs progress via its
    // PLAYER_EVENT variant (adapted in vix-player).
    movieUrl: (tmdbId) =>
      `https://vaplayer.ru/embed/movie/${tmdbId}?autoplay=1&showTitle=false`,
    tvUrl: (tmdbId, season, episode) =>
      `https://vaplayer.ru/embed/tv/${tmdbId}/${season}/${episode}?autoplay=1&showTitle=false`,
  },
  {
    key: "ythd",
    name: "YTHD",
    base: "https://ythd.org",
    host: "cloudorchestranova.com",
    // Signed cloudorchestranova embeds minted per play via /api/ythd/mint
    // (the iframe follows the 302 to the fresh signed URL). Unknown event
    // shape — playable with host progress only where posted.
    movieUrl: (tmdbId) => `/api/ythd/mint?type=movie&id=${tmdbId}`,
    tvUrl: (tmdbId, season, episode) =>
      `/api/ythd/mint?type=tv&id=${tmdbId}&season=${season}&episode=${episode}`,
  },
  {
    key: "xpass",
    name: "XPass",
    base: "https://play.xpass.top",
    host: "play.xpass.top",
    // Minimal loader pages with TMDB ids. Ships sandbox detection — our
    // iframes are unsandboxed, matching what its player expects.
    movieUrl: (tmdbId) =>
      `https://play.xpass.top/e/movie/${tmdbId}?autostart=true`,
    tvUrl: (tmdbId, season, episode) =>
      `https://play.xpass.top/e/tv/${tmdbId}/${season}/${episode}?autostart=true`,
  },
];

/** Origins that must keep accepting PLAYER_EVENT: the vixsrc iframe fallback,
 *  vidfast's documented mirror hosts, plus the legacy mapple.tv host
 *  (dropping any kills progress). */
const LEGACY_PLAYER_ORIGINS = [
  "vixsrc.to",
  "mapple.tv",
  "mapple.fun",
  "vidfast.pro",
  "vidfast.in",
  "vidfast.io",
  "vidfast.me",
  "vidfast.net",
  "vidfast.pm",
  "vidfast.vc",
  "vidfast.xyz",
  "vidfast.bz",
];
export function isEmbedPlayerOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    if (
      LEGACY_PLAYER_ORIGINS.some(
        (h) => url.hostname === h || url.hostname.endsWith(`.${h}`)
      )
    ) {
      return true;
    }
    return EMBED_SOURCES.some(
      (s) =>
        url.hostname === s.host || url.hostname.endsWith(`.${s.host}`)
    );
  } catch {
    return false;
  }
}

// Log a rejected iframe origin once per page load (not per message — spam).
let loggedRejectedOrigin = false;

export function warnOnceRejectedPlayerEvent(origin: string): void {
  if (loggedRejectedOrigin) return;
  loggedRejectedOrigin = true;
  console.warn(
    "[player] PLAYER_EVENT from origin",
    origin,
    "ignored (expected registered embed source)"
  );
}

/** Build an embed URL for a source key (null when not an embed source or
 *  the source has no URL for this media shape — e.g. movie-only embeds). */
export function embedUrlFor(
  key: string,
  type: "movie" | "tv",
  tmdbId: number,
  season?: number,
  episode?: number
): string | null {
  const src = EMBED_SOURCES.find((s) => s.key === key);
  if (!src) return null;
  let url: string | null = null;
  if (type === "movie") url = src.movieUrl(tmdbId);
  else if (season != null && episode != null) url = src.tvUrl(tmdbId, season, episode);
  return url ? url : null;
}

/**
 * Set (or clear with "auto") CineSrc's preferred-quality param. Only CineSrc
 * documents one — other embeds own quality through their own gear menus.
 */
export function withCineSrcQuality(src: string, quality: "auto" | number): string {
  try {
    const url = new URL(src);
    if (quality === "auto") url.searchParams.delete("quality");
    else url.searchParams.set("quality", String(quality));
    return url.toString();
  } catch {
    return src;
  }
}

/**
 * CineSrc sub-servers (its own server menu, exposed in our player).
 *
 * CineSrc documents `lastserver` (preferred server id) + `prioritize=true`
 * embed params, and the embed reports the server it actually uses via the
 * `cinesrc:sourceused { sourceId }` event. Valid ids are CineSrc's own
 * (e.g. "Nebula") — they can only be learned from that event, never guessed.
 * Display names use Greek-god aliases per user request; the real id is always
 * kept alongside so the menu shows what the embed itself will report.
 */
export type CineSrcServerDef = { id: string; name: string; sub?: string };

/** Greek-god display aliases, assigned to discovered servers in order. */
export const CINESRC_SERVER_ALIASES = [
  "Zeus",
  "Odysseus",
  "Hera",
  "Athena",
  "Apollo",
  "Hermes",
  "Artemis",
  "Ares",
  "Hades",
  "Poseidon",
  "Demeter",
  "Hephaestus",
  "Aphrodite",
  "Dionysus",
];

/**
 * CineSrc's real provider ids in its own rotation order, captured from the
 * embed's console (`[Embed] Provider <id> error`, 2026-09-11). These double
 * as the valid `lastserver` values.
 */
export const CINESRC_SEED_SERVERS = [
  "nebula",
  "lisbon",
  "wave",
  "surge",
  "spark",
  "storm",
  "aurora",
  "rush",
  "blizzard",
  "mist",
  "thunder",
  "paris",
  "sturm",
  "brisa",
];

/** Max servers remembered (persisted discovery list stays small). */
export const CINESRC_MAX_KNOWN_SERVERS = 20;

/** Greek alias for a discovered server id (falls back to the raw id). */
export function cineSrcAliasFor(serverId: string, index: number): string {
  return CINESRC_SERVER_ALIASES[index] ?? serverId;
}

/**
 * Picker options: Auto + one entry per discovered real server id.
 * Each entry shows the Greek alias with the real id as sub-label.
 */
export function buildCineSrcServerOptions(knownIds: string[]): CineSrcServerDef[] {
  const seen = new Set<string>();
  const options: CineSrcServerDef[] = [{ id: "auto", name: "Auto" }];
  let aliasIndex = 0;
  for (const raw of knownIds) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const id = raw.trim();
    const key = id.toLowerCase();
    if (id === "auto" || seen.has(key)) continue;
    seen.add(key);
    if (options.length - 1 >= CINESRC_MAX_KNOWN_SERVERS) break;
    options.push({ id, name: cineSrcAliasFor(id, aliasIndex), sub: id });
    aliasIndex++;
  }
  return options;
}

/**
 * Set (or clear with "auto") CineSrc's preferred-server hint. Named servers
 * set `lastserver=<id>&prioritize=true`; "auto" drops both params so CineSrc
 * picks its own default. The id must be one of CineSrc's real server ids
 * (learned from `cinesrc:sourceused`) — unknown ids are ignored server-side.
 */
export function withCineSrcServer(src: string, serverId: string): string {
  try {
    const url = new URL(src);
    if (!serverId || serverId === "auto") {
      url.searchParams.delete("lastserver");
      url.searchParams.delete("prioritize");
    } else {
      url.searchParams.set("lastserver", serverId);
      url.searchParams.set("prioritize", "true");
    }
    return url.toString();
  } catch {
    return src;
  }
}

/**
 * Display name for a CineSrc server id within a known list: Greek alias when
 * discovered, "Auto" for the default. Unknown ids show raw (never blank).
 */
export function cineSrcServerLabel(serverId: string, knownIds: string[] = []): string {
  if (!serverId || serverId === "auto") return "Auto";
  const idx = knownIds.indexOf(serverId);
  if (idx >= 0) return cineSrcAliasFor(serverId, idx);
  return serverId;
}

export const CINESRC_ORIGIN = "https://cinesrc.st";

export function sendCineSrcCommand(
  iframe: HTMLIFrameElement | null,
  command: string,
  args: unknown[] = []
): void {
  iframe?.contentWindow?.postMessage(
    { type: "cinesrc:command", command, args },
    CINESRC_ORIGIN
  );
}

/**
 * VidFast control channel, per its PostMessage docs:
 * {command:"play"} | {command:"pause"} | {command:"seek", time} |
 * {command:"volume", level: 0-1} | {command:"mute", muted: bool} |
 * {command:"getStatus"} (replies via PLAYER_EVENT playerstatus).
 * Always targets "*" per VidFast's own docs: the player redirects across
 * vidfast.* mirrors internally, so the src origin is unreliable and an
 * explicit origin silently drops every command (dead remote). Inbound
 * events are still origin-validated (see isEmbedPlayerOrigin).
 */
export function sendVidfastCommand(
  iframe: HTMLIFrameElement | null,
  command: "play" | "pause" | "seek" | "volume" | "mute" | "getStatus",
  data: Record<string, unknown> = {}
): void {
  iframe?.contentWindow?.postMessage({ command, ...data }, "*");
}

/** Label for a source key ("Vix" | "Goated" | registry names). */
export function sourceLabel(key: string): string {
  if (key === "vix") return "Vix";
  if (key === "goated") return "Goated";
  return EMBED_SOURCES.find((s) => s.key === key)?.name ?? key;
}
