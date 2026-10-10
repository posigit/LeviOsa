/**
 * data.vidsrc.sh stream-data client (server-side port of the embed's vsdec.js).
 *
 * Gated chain (single-use IP-bound api_token, reuse => 403 — mint per call):
 *   vs_src.php -> landing (CFG.playerUrl) -> player page (CONFIG.apiToken)
 *   -> GET {api|streamBase}&stream_urls&api_token=... -> WASM-decrypt below.
 * Inner/embed hosts rotate — always follow vs_src.php, never hardcode.
 * API: GET https://data.vidsrc.sh/api.php?type=movie|tv&tmdb={id}
 *      [&season=N&episode=N][&stream_urls]
 * Returns plain JSON, EXCEPT data.stream_urls which — when protection is on —
 * is a single encrypted string (base64 ChaCha20 nonce||ciphertext) plus a
 * top-level `vs` carrying the per-5-minute-window decryptor:
 *     vs: { w: <window>, wasm_url: "https://.../<w>.wasm" }  (preferred)
 *  or vs: { w: <window>, wasm: "<base64 wasm>" }             (inline fallback)
 * The decryptor is IETF ChaCha20 (see the pure-JS port below — the module's
 * data segments are re-laid-out every window, so key halves are found by
 * trial-decrypting each >=32-byte segment and keeping the URL-plaintext
 * winner). Plain responses (stream_urls already an array) pass through
 * unchanged.
 *
 * Runs in Node (Vercel) and Workers unchanged — only fetch + TextDecoder.
 * (An earlier revision decrypted via WebAssembly.compile; Workers disallow
 * dynamic WASM compilation, which 502d every resolve in production.)
 */

import {
  SHARED_UA as UA,
  fetchWithTimeout,
  isBlockedHost,
} from "@/lib/stream-proxy";

const VIDSRC_SH_API = "https://data.vidsrc.sh/api.php";
const VIDSRC_SH_REFERER = "https://vidsrc.sh/";
const VIDSRC_SH_BASE = "https://vidsrc.sh";

/** Minted single-use stream-data token + the api URL it unlocks. Never cache. */
type VidsrcShGate = {
  /** stream_urls URL WITHOUT the token (caller appends &api_token=). */
  apiUrl: string;
  apiToken: string;
  /** Referer to send on the data API call (player origin). */
  referer: string;
};

function unescapeInlineJson(s: string): string {
  return s.replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
}

function assertPublicHttps(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`vidsrc.sh gate invalid ${what}`);
  }
  if (u.protocol !== "https:" || isBlockedHost(u.hostname)) {
    throw new Error(`vidsrc.sh gate blocked ${what}`);
  }
  return u;
}

/**
 * Mint a fresh single-use api_token via the gated embed chain:
 *   vs_src.php -> landing (CFG.playerUrl) -> player page (CONFIG.apiToken).
 * Tokens are IP-bound + single-use (reuse => 403): mint per resolve, use once,
 * back-to-back, no caching. Inner/embed hosts rotate — always follow vs_src.
 */
async function vidsrcShMintGate(opts: {
  type: "movie" | "tv";
  imdb: string;
  season?: number;
  episode?: number;
}): Promise<VidsrcShGate> {
  if (!/^tt\d+$/.test(opts.imdb)) throw new Error("invalid imdb id");
  const isTv = opts.type === "tv";
  const se = isTv ? `/${opts.season}/${opts.episode}` : "";

  // 1. Gate URL (short-lived, host-bound ?vs= target on a rotating host).
  const vsParams =
    `type=${opts.type}&id=${encodeURIComponent(opts.imdb)}` +
    (isTv ? `&season=${opts.season}&episode=${opts.episode}` : "");
  const embedUrl = `${VIDSRC_SH_BASE}/embed/${opts.type}/${encodeURIComponent(opts.imdb)}${se}`;
  const vsRes = await fetchWithTimeout(
    `${VIDSRC_SH_BASE}/vs_src.php?${vsParams}`,
    {
      headers: { "User-Agent": UA, Referer: embedUrl, Accept: "application/json" },
      cache: "no-store",
    },
    10_000
  );
  if (!vsRes.ok) throw new Error(`vidsrc.sh gate ${vsRes.status}`);
  let src: string | null = null;
  try {
    src = ((await vsRes.json()) as { src?: unknown }).src as string;
  } catch {
    src = null;
  }
  if (typeof src !== "string" || !src) throw new Error("vidsrc.sh gate empty src");
  const innerUrl = assertPublicHttps(src, "src");

  // 2. Landing page -> nested player path (CFG.playerUrl).
  const innerRes = await fetchWithTimeout(
    innerUrl.toString(),
    { headers: { "User-Agent": UA, Referer: embedUrl }, cache: "no-store" },
    10_000
  );
  if (!innerRes.ok) throw new Error(`vidsrc.sh gate ${innerRes.status}`);
  const innerHtml = await innerRes.text();
  const playerPath = innerHtml.match(/\/embed\/player\/[^\s"'<>\\]+/)?.[0];
  if (!playerPath) throw new Error("vidsrc.sh gate missing player");
  const playerUrl = assertPublicHttps(
    new URL(playerPath, innerUrl.origin).toString(),
    "player"
  );

  // 3. Player page -> window.CONFIG { api|streamBase, apiToken }.
  const playerRes = await fetchWithTimeout(
    playerUrl.toString(),
    {
      headers: { "User-Agent": UA, Referer: innerUrl.toString() },
      cache: "no-store",
    },
    10_000
  );
  if (!playerRes.ok) throw new Error(`vidsrc.sh gate ${playerRes.status}`);
  const playerHtml = await playerRes.text();
  const apiM =
    playerHtml.match(/"api"\s*:\s*"([^"]+)"/)?.[1] ??
    playerHtml.match(/"streamBase"\s*:\s*"([^"]+)"/)?.[1];
  const tokenM = playerHtml.match(/"apiToken"\s*:\s*"([^"]+)"/)?.[1];
  if (!apiM || !tokenM) throw new Error("vidsrc.sh gate missing token");
  let apiUrl = unescapeInlineJson(apiM);
  if (!/^https:\/\/data\.vidsrc\.sh\/api\.php\?/.test(apiUrl)) {
    throw new Error("vidsrc.sh gate blocked api");
  }
  if (isTv && !/[?&]stream_urls/.test(apiUrl)) {
    // TV embeds streamBase without S/E: player appends &season=&episode=&stream_urls.
    apiUrl += `&season=${encodeURIComponent(String(opts.season))}&episode=${encodeURIComponent(String(opts.episode))}&stream_urls`;
  }
  return { apiUrl, apiToken: tokenM, referer: `${playerUrl.origin}/` };
}

/** Metadata-only lookup (no token needed) to map app tmdb id -> imdb id. */
async function vidsrcShImdbId(opts: {
  type: "movie" | "tv";
  tmdb: number;
  season?: number;
  episode?: number;
}): Promise<string> {
  const q = new URLSearchParams({ type: opts.type, tmdb: String(opts.tmdb) });
  if (opts.type === "tv") {
    q.set("season", String(opts.season));
    q.set("episode", String(opts.episode));
  }
  const res = await fetchWithTimeout(
    `${VIDSRC_SH_API}?${q.toString()}`,
    {
      headers: {
        "User-Agent": UA,
        Referer: VIDSRC_SH_REFERER,
        Accept: "application/json",
      },
      cache: "no-store",
    },
    15_000
  );
  if (!res.ok) throw new Error(`vidsrc.sh api ${res.status}`);
  const j = (await res.json()) as VsApiResponse;
  const imdb = j.data?.imdb_id;
  if (typeof imdb !== "string" || !/^tt\d+$/.test(imdb)) {
    throw new Error("vidsrc.sh missing imdb id");
  }
  return imdb;
}

export type VidsrcShResolve = {
  title?: string | null;
  imdbId?: string | null;
  fileName?: string | null;
  backdrop?: string | null;
  /** Direct stream URLs (decrypted). Empty when the title has none. */
  urls: string[];
  /** Seek-preview thumbnails (VTT URL) when the API provides one. */
  thumbnailsUrl?: string | null;
  subtitles: { language: string; label: string; url: string }[];
};

type VsApiResponse = {
  status_code?: string | number;
  data?: {
    title?: string;
    imdb_id?: string;
    file_name?: string;
    backdrop?: string;
    stream_urls?: string | string[];
  };
  /** Seek-preview thumbnails + default subs live TOP-level (not under data). */
  thumbnails_url?: string;
  default_subs?: { language?: string; label?: string; url?: string }[];
  vs?: {
    w?: string | number | null;
    wasm_url?: string;
    wasm?: string;
  };
};

function b64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/**
 * Pure-JS port of the vsdec decryptor — no WebAssembly.
 *
 * Why: Cloudflare Workers (this app's production runtime) disallow dynamic
 * WASM compilation ("Wasm code generation disallowed by embedder"), so the
 * per-5-minute-window decryptor module can be fetched but never compiled
 * there. Verified live: the whole gated chain (vs_src -> landing -> player
 * -> data API -> wasm fetch) succeeds from the worker; only the compile
 * step throws, 502ing every resolve.
 *
 * What the module does (reversed from its WAT): IETF ChaCha20, 20 rounds,
 * sigma "expand 32-byte k", counter from 0, 12-byte nonce = the payload's
 * first 12 bytes. The 32-byte key is mem[0:32] XOR mem[B:B+32], where the
 * module's data segments are re-laid-out every window (B was 512, then
 * 2560 — the code is polymorphically regenerated, only the shape is
 * stable). So instead of trusting offsets we trial-decrypt each >=32-byte
 * data segment as B and keep the one whose plaintext is URL lines. Cheap
 * (~1.5KB payloads) and self-validating; the winning offsets are cached
 * per window.
 *
 * Runs in Node (Vercel/dev) and Workers unchanged — only fetch + TextDecoder.
 */

function readU32LEB(buf: Uint8Array, pos: number): [number, number] {
  let v = 0;
  let s = 0;
  let b = 0;
  do {
    if (pos >= buf.length) throw new Error("vidsrc.sh decryptor layout changed");
    b = buf[pos++];
    v |= (b & 0x7f) << s;
    s += 7;
    if (s > 35) throw new Error("vidsrc.sh decryptor layout changed");
  } while (b & 0x80);
  return [v >>> 0, pos];
}

/** Initial linear-memory image + data-segment offsets from raw wasm bytes. */
function parseVsSegments(wasm: Uint8Array): {
  mem: Uint8Array;
  segs: { off: number; len: number }[];
} {
  let pos = 8; // skip magic + version
  let memSize = 0;
  const raw: { off: number; bytes: Uint8Array }[] = [];
  while (pos < wasm.length) {
    const id = wasm[pos++];
    let size: number;
    [size, pos] = readU32LEB(wasm, pos);
    const end = pos + size;
    if (id === 5) {
      // memory section: count, flags, initial pages.
      let n: number;
      [n, pos] = readU32LEB(wasm, pos);
      void n;
      let flags: number;
      [flags, pos] = readU32LEB(wasm, pos);
      void flags;
      let init: number;
      [init, pos] = readU32LEB(wasm, pos);
      memSize = init * 65536;
    } else if (id === 11) {
      // data section: count, then (flags, i32.const off, end, size, bytes).
      let n: number;
      [n, pos] = readU32LEB(wasm, pos);
      for (let i = 0; i < n; i++) {
        const flags = wasm[pos++];
        if (flags & 0x01) throw new Error("vidsrc.sh decryptor has passive segments");
        if (flags & 0x02) {
          // Active segment with explicit memory index — skip it.
          let memidx: number;
          [memidx, pos] = readU32LEB(wasm, pos);
          void memidx;
        }
        if (wasm[pos++] !== 0x41) throw new Error("vidsrc.sh decryptor layout changed");
        let off: number;
        [off, pos] = readU32LEB(wasm, pos);
        if (wasm[pos++] !== 0x0b) throw new Error("vidsrc.sh decryptor layout changed");
        let sz: number;
        [sz, pos] = readU32LEB(wasm, pos);
        raw.push({ off, bytes: wasm.subarray(pos, pos + sz) });
        pos += sz;
      }
    }
    pos = end;
  }
  const mem = new Uint8Array(memSize || 262144);
  for (const { off, bytes } of raw) mem.set(bytes, off);
  return { mem, segs: raw.map(({ off, bytes }) => ({ off, len: bytes.length })) };
}

function u32le(mem: Uint8Array, o: number): number {
  return (mem[o] | (mem[o + 1] << 8) | (mem[o + 2] << 16) | (mem[o + 3] << 24)) >>> 0;
}

function chachaRotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function chachaQr(x: number[], a: number, b: number, c: number, d: number): void {
  x[a] = (x[a] + x[b]) >>> 0;
  x[d] = chachaRotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0;
  x[b] = chachaRotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0;
  x[d] = chachaRotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0;
  x[b] = chachaRotl(x[b] ^ x[c], 7);
}

function chachaBlock(key: number[], counter: number, nonce: number[]): Uint8Array {
  const st = [
    0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
    ...key,
    counter >>> 0,
    ...nonce,
  ];
  const w = st.slice();
  for (let i = 0; i < 10; i++) {
    chachaQr(w, 0, 4, 8, 12);
    chachaQr(w, 1, 5, 9, 13);
    chachaQr(w, 2, 6, 10, 14);
    chachaQr(w, 3, 7, 11, 15);
    chachaQr(w, 0, 5, 10, 15);
    chachaQr(w, 1, 6, 11, 12);
    chachaQr(w, 2, 7, 8, 13);
    chachaQr(w, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (w[i] + st[i]) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

/** Decrypt with key = mem[offA:offA+32] XOR mem[offB:offB+32]. */
function chachaDecryptWithSegs(
  mem: Uint8Array,
  offA: number,
  offB: number,
  enc: Uint8Array
): string {
  const key: number[] = [];
  for (let i = 0; i < 8; i++) {
    key.push((u32le(mem, offA + i * 4) ^ u32le(mem, offB + i * 4)) >>> 0);
  }
  const nonce = [u32le(enc, 0), u32le(enc, 4), u32le(enc, 8)];
  const ct = enc.subarray(12);
  const pt = new Uint8Array(ct.length);
  let counter = 0;
  let done = 0;
  while (done < ct.length) {
    const ks = chachaBlock(key, counter++, nonce);
    const n = Math.min(64, ct.length - done);
    for (let i = 0; i < n; i++) pt[done + i] = ct[done + i] ^ ks[i];
    done += n;
  }
  return new TextDecoder().decode(pt);
}

/** True when the decrypted text is newline-separated https URLs (not garbage). */
function looksLikeStreamUrls(text: string): boolean {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((l) => /^https:\/\/[^\s"'<>\\]+$/.test(l))
  );
}

/** Winning key-segment offsets per window — avoids re-trialing every call. */
const vsKeyCache = new Map<string, { a: number; b: number }>();
const VS_KEY_CACHE_MAX = 8;

function vsCacheKey(vs: NonNullable<VsApiResponse["vs"]>): string | null {
  const w = vs.w == null ? null : String(vs.w);
  if (w) return `w:${w}`;
  return null;
}

function vsCacheSet(key: string, v: { a: number; b: number }): void {
  if (vsKeyCache.has(key)) vsKeyCache.delete(key);
  vsKeyCache.set(key, v);
  while (vsKeyCache.size > VS_KEY_CACHE_MAX) {
    const oldest = vsKeyCache.keys().next().value;
    if (oldest == null) break;
    vsKeyCache.delete(oldest);
  }
}

/** Raw decryptor bytes for this response (fetched per window, or inline). */
async function vsDecryptorBytes(
  vs: NonNullable<VsApiResponse["vs"]>
): Promise<Uint8Array | null> {
  if (vs.wasm_url) {
    let target: URL;
    try {
      target = new URL(vs.wasm_url);
    } catch {
      throw new Error("vidsrc.sh returned an invalid wasm_url");
    }
    if (target.protocol !== "https:" || isBlockedHost(target.hostname)) {
      throw new Error("vidsrc.sh returned a blocked wasm_url");
    }
    const res = await fetchWithTimeout(
      target.toString(),
      {
        headers: { "User-Agent": UA, Referer: VIDSRC_SH_REFERER },
        cache: "no-store",
      },
      15_000
    );
    if (!res.ok) throw new Error(`wasm ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024) {
      throw new Error("vidsrc.sh returned an invalid decryptor");
    }
    return new Uint8Array(buf);
  }
  if (vs.wasm) {
    const bytes = b64ToBytes(vs.wasm);
    if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) {
      throw new Error("vidsrc.sh returned an invalid inline wasm");
    }
    return bytes;
  }
  return null;
}

async function decryptUrls(
  vs: NonNullable<VsApiResponse["vs"]>,
  encB64: string
): Promise<string[]> {
  const wasmBytes = await vsDecryptorBytes(vs);
  if (!wasmBytes) return [];
  const enc = b64ToBytes(encB64);
  if (enc.length <= 12 || enc.length > 256 * 1024) {
    throw new Error("vidsrc.sh returned an invalid encrypted payload");
  }
  const { mem, segs } = parseVsSegments(wasmBytes);
  // Exact-32-byte segments first (both key halves have been exactly 32B so
  // far), then any segment with 32+ readable bytes. A side has always been
  // at 0, but fall back to a full pair search if that ever changes.
  const exact = segs.filter((s) => s.len === 32).map((s) => s.off);
  const any32 = segs.filter((s) => s.len >= 32).map((s) => s.off);
  const orderedB = [...exact, ...any32.filter((o) => !exact.includes(o))];
  const ck = vsCacheKey(vs);
  const cached = ck ? vsKeyCache.get(ck) : undefined;
  const attempts: { a: number; b: number }[] = [];
  if (cached) attempts.push(cached);
  for (const b of orderedB) {
    if (cached && cached.a === 0 && cached.b === b) continue;
    attempts.push({ a: 0, b });
  }
  if (exact.length > 1) {
    for (const a of exact) {
      for (const b of exact) {
        if (a === 0) continue; // already tried above
        if (cached && cached.a === a && cached.b === b) continue;
        attempts.push({ a, b });
      }
    }
  }
  for (const { a, b } of attempts) {
    if (a + 32 > mem.length || b + 32 > mem.length) continue;
    let text: string;
    try {
      text = chachaDecryptWithSegs(mem, a, b, enc);
    } catch {
      continue;
    }
    if (!looksLikeStreamUrls(text)) continue;
    if (ck) vsCacheSet(ck, { a, b });
    return text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  throw new Error("vidsrc.sh decrypt failed");
}

export async function vidsrcShResolve(opts: {
  type: "movie" | "tv";
  id: number;
  season?: number;
  episode?: number;
}): Promise<VidsrcShResolve> {
  if (!Number.isSafeInteger(opts.id) || opts.id <= 0) {
    throw new Error("invalid tmdb id");
  }
  if (opts.type === "tv" && (opts.season == null || opts.episode == null)) {
    throw new Error("season and episode are required for tv");
  }
  // data.vidsrc.sh gates &stream_urls behind a single-use IP-bound api_token
  // (player page CONFIG.apiToken; reuse => 403). Mint per resolve via the
  // vs_src -> landing -> player chain, then stamp the token exactly once.
  const imdb = await vidsrcShImdbId({
    type: opts.type,
    tmdb: opts.id,
    season: opts.season,
    episode: opts.episode,
  });
  const gate = await vidsrcShMintGate({
    type: opts.type,
    imdb,
    season: opts.season,
    episode: opts.episode,
  });
  const apiUrl = `${gate.apiUrl}${gate.apiUrl.includes("?") ? "&" : "?"}api_token=${encodeURIComponent(gate.apiToken)}`;
  const res = await fetchWithTimeout(
    apiUrl,
    {
      headers: {
        "User-Agent": UA,
        Referer: gate.referer,
        Accept: "application/json",
      },
      cache: "no-store",
    },
    15_000
  );
  if (!res.ok) throw new Error(`vidsrc.sh api ${res.status}`);
  const j = (await res.json()) as VsApiResponse;
  const d = j.data ?? {};
  let urls: string[] = [];
  if (Array.isArray(d.stream_urls)) {
    urls = d.stream_urls.filter(
      (u): u is string =>
        typeof u === "string" &&
        u.length > 0 &&
        u.startsWith("https://") &&
        (() => {
          try {
            const x = new URL(u);
            return x.protocol === "https:" && !isBlockedHost(x.hostname);
          } catch {
            return false;
          }
        })()
    );
  } else if (typeof d.stream_urls === "string" && d.stream_urls.length > 0) {
    if (j.vs) {
      const raw = await decryptUrls(j.vs, d.stream_urls);
      urls = raw.filter((u) => {
        try {
          const x = new URL(u);
          return x.protocol === "https:" && !isBlockedHost(x.hostname);
        } catch {
          return false;
        }
      });
    }
  }
  const thumbs =
    typeof j.thumbnails_url === "string" && j.thumbnails_url.length > 0
      ? j.thumbnails_url
      : null;
  let thumbsValidated: string | null = null;
  if (thumbs) {
    try {
      const x = new URL(thumbs, VIDSRC_SH_API);
      if (x.protocol === "https:" && !isBlockedHost(x.hostname)) {
        thumbsValidated = x.toString();
      }
    } catch {
      thumbsValidated = null;
    }
  }
  return {
    title: d.title ?? null,
    imdbId: d.imdb_id ?? null,
    fileName: d.file_name ?? null,
    backdrop: d.backdrop ?? null,
    urls,
    thumbnailsUrl: thumbsValidated,
    subtitles: Array.isArray(j.default_subs)
      ? j.default_subs.flatMap((s) =>
          s && typeof s.url === "string" && s.url.length > 0
            ? (() => {
                try {
                  const x = new URL(s.url);
                  if (x.protocol !== "https:" || isBlockedHost(x.hostname)) return [];
                } catch {
                  return [];
                }
                return [
                  {
                    language: typeof s.language === "string" ? s.language : "en",
                    label: typeof s.label === "string" ? s.label : "English",
                    url: s.url,
                  },
                ];
              })()
            : []
        )
      : [],
  };
}

/** Origin (protocol + host) of a stream URL — tokens are per-host. */
export function vidsrcShOrigin(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}`;
  } catch {
    return "";
  }
}

/** Per-origin JWT cache (tokens live ~4h; refresh hourly to stay safe). Bounded LRU. */
const tokenCache = new Map<string, { token: string; at: number }>();
const TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_CACHE_MAX = 32;

/**
 * Fetch a playback token from the stream host (mirrors the embed player's
 * loadStream: GET {origin}/generate.php). Tokens are IP-bound (/24), so the
 * SAME deployment that mints must also proxy the bytes — never hand raw
 * tokenized URLs to the browser.
 */
export async function vidsrcShToken(origin: string): Promise<string> {
  const hit = tokenCache.get(origin);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) {
    // Refresh LRU order.
    tokenCache.delete(origin);
    tokenCache.set(origin, hit);
    return hit.token;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new Error("invalid stream origin");
  }
  if (originUrl.protocol !== "https:" || isBlockedHost(originUrl.hostname)) {
    throw new Error("blocked stream origin");
  }
  const res = await fetchWithTimeout(
    `${origin}/generate.php`,
    {
      headers: { "User-Agent": UA, Referer: "https://cloudorchestranova.com/" },
      cache: "no-store",
    },
    10_000
  );
  if (!res.ok) {
    // Do not cache failures.
    throw new Error(`token endpoint ${res.status}`);
  }
  const token = (await res.text()).trim();
  if (!token || token.length > 4096) throw new Error("empty playback token");
  tokenCache.delete(origin);
  tokenCache.set(origin, { token, at: Date.now() });
  while (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest == null) break;
    tokenCache.delete(oldest);
  }
  return token;
}

/**
 * Drop the cached origin token and mint fresh. Call when upstream answers
 * 401/403 on a token we minted: serverless egress IPs rotate, and a token
 * bound to the old /24 dies with it. Never cached on failure (see above).
 */
export async function vidsrcShRefreshToken(origin: string): Promise<string> {
  tokenCache.delete(origin);
  return vidsrcShToken(origin);
}

/** Append ?token= like the embed player's applyToken (respects __TOKEN__). */
export function applyVidsrcToken(url: string, token: string): string {
  if (!token) return url;
  if (url.includes("__TOKEN__")) return url.split("__TOKEN__").join(token);
  return url + (url.includes("?") ? "&" : "?") + "token=" + token;
}

// ---------- proxy URL signing (abuse guard, WebCrypto — Node + Workers) ----------
// /api/vidsrc-sh/media would otherwise be an open https fetch proxy —
// anyone could burn our bandwidth. Stream + media routes sign every URL
// they mint with AUTH_SECRET, so only OUR chain validates. Cross-instance
// safe (shared env secret, no shared memory). Signatures expire (default
// 1h) so leaked URLs cannot be replayed forever.

let warnedNoSecret = false;

function proxySecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("[vidsrc-sh] AUTH_SECRET missing/short in production — refusing to sign");
  }
  if (!warnedNoSecret) {
    warnedNoSecret = true;
    console.warn(
      "[vidsrc-sh] AUTH_SECRET missing/short — proxy URLs signed with an insecure dev fallback (non-production only)"
    );
  }
  return "dev-only-insecure-proxy-key";
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 = typeof Buffer !== "undefined"
    ? Buffer.from(s, "binary").toString("base64")
    : btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacHex(target: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(proxySecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${exp}.${target}`)
  );
  return b64url(new Uint8Array(sig));
}

/** Build an expiring signed /api/vidsrc-sh/media URL for a target. */
export async function signProxyUrl(target: string, ttlSec = 3600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(target, exp);
  return `/api/vidsrc-sh/media?url=${encodeURIComponent(target)}&exp=${exp}&sig=${sig}`;
}

/** Sync signing is not supported (WebCrypto is async) — kept to fail loudly if reused. */
export function signProxyUrlSync(): string {
  throw new Error("signProxyUrl is async — await signProxyUrl(target)");
}

/** True when sig matches target and exp is fresh (constant-time compare). */
export async function verifyProxyUrl(
  target: string,
  sig: string | null,
  expRaw: string | null
): Promise<boolean> {
  if (!sig || !expRaw) return false;
  if (!/^\d+$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp < now - 60 || exp > now + 7 * 24 * 3600) {
    return false;
  }
  const expected = await hmacHex(target, exp);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
