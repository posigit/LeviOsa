import { NextRequest, NextResponse } from "next/server";
import { unzipSync } from "fflate";
import { looksLatin, toVtt } from "@/lib/player-subs";

/**
 * SubDL (subdl.com) subtitle lookup, gated on SUBDL_API_KEY
 * (free key: https://subdl.com/panel/api). Mirrors /api/vixsrc/subs
 * (OpenSubtitles) so the CC picker and the engine cascade treat both alike:
 *
 *   GET ?tmdbId=&type=movie|tv&season=&episode=&list=1 → { items }   (no download)
 *   GET ?fileId=/subtitle/...                          → { vtt, label, fileId }
 *   GET ?tmdbId=&type=…                                → best match as VTT
 *                                                        (Auto cascade)
 *
 * Search keys on TMDB ids (SubDL's primary id) with an IMDb fallback, so
 * embeds that never resolve IMDb still get subtitles.
 *
 * Keys are never sent to the browser: the search response embeds the key in
 * each download url, we strip it for fileId and re-attach it server-side
 * (authenticated downloads — the anonymous limit is 300/day/IP).
 */
export const dynamic = "force-dynamic";

const SEARCH = "https://api.subdl.com/api/v1/subtitles";
const DL = "https://dl.subdl.com";
/** Only surface the top N ranked English files in the player picker. */
const LIST_LIMIT = 3;
/** Bound the auto-cascade download loop (each try costs quota). */
const MAX_AUTO_TRIES = 3;
const UPSTREAM_TIMEOUT_MS = 20_000;

type SdlUnpackFile = {
  file_n_id?: string;
  name?: string;
  language?: string;
  format?: string;
  season?: number;
  episode?: number;
  hi?: boolean;
  url: string;
};

type SdlSub = {
  release_name?: string;
  name?: string;
  url?: string;
  language?: string;
  season?: number;
  episode?: number | null;
  hi?: boolean;
  full_season?: boolean;
  unpack_files?: SdlUnpackFile[];
};

/** One downloadable file, expanded out of the search rows. */
type SdlCandidate = {
  /** Download path without any query string (safe to hand to the client). */
  fileId: string;
  label: string;
  format: string;
  hi: boolean;
  /** Sort key: lower = a better match for this movie/episode. */
  rank: number;
};

/** Strip the api_key query SubDL appends, validate it stays on dl.subdl.com. */
function toFileId(url: string): string | null {
  const path = url.split("?")[0];
  if (!/^\/subtitle\/[A-Za-z0-9._\-/]+$/.test(path)) return null;
  if (path.includes("..")) return null;
  return path;
}

function isEnglish(row: SdlSub): boolean {
  const lang = (row.language ?? "").toLowerCase();
  return !lang || lang.startsWith("en");
}

function labelFor(row: SdlSub, file?: SdlUnpackFile): string {
  const label = (file?.name ?? row.release_name ?? row.name ?? "")
    .trim()
    .slice(0, 80);
  return label || "SubDL (English)";
}

/**
 * Expand search rows into ranked files. Episode-specific unpack files win
 * (SubDL returns one per episode in a season pack), then whole-file zips.
 * Files whose season/episode clearly disagree with the requested episode are
 * dropped — a near-miss pack still ranks below a real one, but a wrong
 * episode is junk. Stable within each tier so SubDL's own relevance order is
 * preserved.
 */
function candidates(
  rows: SdlSub[],
  type: string,
  season?: number,
  episode?: number
): SdlCandidate[] {
  const out: SdlCandidate[] = [];
  for (const row of rows) {
    if (!isEnglish(row) || !row.url) continue;
    const rowSeason = row.season ?? 0;
    const rowEpisode = row.episode ?? null;
    const seasonOk =
      type !== "tv" || season == null || row.season == null || rowSeason === season;
    const episodeOk =
      type !== "tv" || episode == null || rowEpisode == null || rowEpisode === episode;

    if (row.unpack_files?.length) {
      for (const file of row.unpack_files) {
        if (!file.url) continue;
        if (file.language && !file.language.toLowerCase().startsWith("en")) continue;
        const fileId = toFileId(file.url);
        if (!fileId) continue;
        const fSeason = file.season ?? rowSeason;
        const fEpisode = file.episode ?? null;
        if (type === "tv" && season != null && fSeason !== season) continue;
        if (type === "tv" && episode != null && fEpisode != null && fEpisode !== episode) {
          continue;
        }
        const exact = type === "tv" && episode != null && fEpisode === episode;
        const rank = (exact ? 0 : fEpisode == null ? 1 : 2) + (file.hi ? 1 : 0);
        out.push({
          fileId,
          label: labelFor(row, file),
          format: (file.format ?? "srt").toLowerCase(),
          hi: !!file.hi,
          rank,
        });
      }
      continue;
    }

    if (!seasonOk || !episodeOk) continue;
    const fileId = toFileId(row.url);
    if (!fileId) continue;
    const ext = (row.name ?? "").split(".").pop()?.toLowerCase();
    const format = ext && ext !== "zip" ? ext : "srt";
    const exact = type === "tv" && episode != null && rowEpisode === episode;
    const rank = (exact ? 0 : rowEpisode == null ? 1 : 2) + (row.hi ? 1 : 0);
    out.push({ fileId, label: labelFor(row), format, hi: !!row.hi, rank });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** Append the key server-side (SubDL puts it in search urls; we stripped it). */
function withKey(path: string): string {
  const key = process.env.SUBDL_API_KEY;
  if (!key) return path;
  return `${path}${path.includes("?") ? "&" : "?"}api_key=${key}`;
}

function bestEntry(
  entries: Record<string, Uint8Array>,
  opts: { type: string; season?: number; episode?: number }
): { name: string; bytes: Uint8Array } | null {
  const names = Object.keys(entries).filter((n) => !n.endsWith("/"));
  if (names.length === 0) return null;
  const wanted = /\.(srt|vtt|ass|ssa|sub|txt)$/i;
  let ranked = names.filter((n) => wanted.test(n));
  if (ranked.length === 0) ranked = names;
  if (opts.type === "tv" && opts.season != null && opts.episode != null) {
    const ep = new RegExp(
      `s0?${opts.season}\\s*e0?${opts.episode}(?![0-9])`,
      "i"
    );
    const exact = ranked.filter((n) => ep.test(n));
    if (exact.length > 0) ranked = exact;
  }
  const name = ranked[0];
  return { name, bytes: entries[name] };
}

async function downloadCandidate(
  cand: SdlCandidate,
  opts: { type: string; season?: number; episode?: number }
): Promise<{ vtt: string } | null> {
  const res = await fetch(withKey(`${DL}${cand.fileId}`), {
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const isZip =
    cand.format === "zip" ||
    (res.headers.get("content-type") ?? "").includes("zip") ||
    (buf[0] === 0x50 && buf[1] === 0x4b);

  let raw: string | null = null;
  if (isZip) {
    try {
      const entries = unzipSync(buf);
      const pick = bestEntry(entries, opts);
      if (pick) raw = new TextDecoder().decode(pick.bytes);
    } catch {
      return null;
    }
  } else {
    raw = new TextDecoder().decode(buf);
  }
  if (!raw) return null;
  const vtt = toVtt(raw);
  // SubDL lets uploaders tag any file EN — drop entries whose text is clearly
  // not Latin-script instead of storing junk under an English label.
  if (!looksLatin(vtt)) return null;
  return { vtt };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const tmdbId = sp.get("tmdbId");
  const imdbId = sp.get("imdbId");
  const type = sp.get("type") === "tv" ? "tv" : "movie";
  const season = sp.get("season");
  const episode = sp.get("episode");
  const listOnly = sp.get("list") === "1" || sp.get("list") === "true";
  const fileId = sp.get("fileId");
  const apiKey = process.env.SUBDL_API_KEY;

  if (!tmdbId && !imdbId) {
    return NextResponse.json({ error: "tmdbId or imdbId required" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "SubDL not configured" }, { status: 501 });
  }

  try {
    // Download a specific file the user picked from the list.
    if (fileId) {
      const path = toFileId(fileId);
      if (!path) {
        return NextResponse.json({ error: "invalid fileId" }, { status: 400 });
      }
      const cand: SdlCandidate = {
        fileId: path,
        label: sp.get("label") || "SubDL (English)",
        format: "srt",
        hi: false,
        rank: 0,
      };
      const got = await downloadCandidate(cand, {
        type,
        season: season ? Number(season) : undefined,
        episode: episode ? Number(episode) : undefined,
      });
      if (!got) {
        return NextResponse.json({ error: "subtitle download failed" }, { status: 404 });
      }
      return NextResponse.json({ ...got, label: cand.label, fileId: path });
    }

    const q = new URLSearchParams({
      api_key: apiKey,
      languages: "EN",
      subs_per_page: "30",
      unpack: "1",
      type,
    });
    if (tmdbId) q.set("tmdb_id", tmdbId);
    else if (imdbId) q.set("imdb_id", imdbId.replace(/^tt/, ""));
    if (type === "tv") {
      if (season) q.set("season_number", season);
      if (episode) q.set("episode_number", episode);
    }
    const searchRes = await fetch(`${SEARCH}?${q.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!searchRes.ok) throw new Error(`subdl search ${searchRes.status}`);
    const search = (await searchRes.json()) as { status?: boolean; subtitles?: SdlSub[] };
    if (!search.status) throw new Error("subdl search rejected");

    const ranked = candidates(
      search.subtitles ?? [],
      type,
      season ? Number(season) : undefined,
      episode ? Number(episode) : undefined
    ).filter((c, i, all) => all.findIndex((x) => x.fileId === c.fileId) === i);
    if (ranked.length === 0) {
      return NextResponse.json({ error: "no subtitles found" }, { status: 404 });
    }

    // List mode: return choices without consuming a download.
    if (listOnly) {
      return NextResponse.json({
        items: ranked.slice(0, LIST_LIMIT).map((c) => ({
          fileId: c.fileId,
          label: c.label,
          downloads: 0,
          format: c.format,
        })),
      });
    }

    // Auto: first candidate that yields usable English text.
    for (const cand of ranked.slice(0, MAX_AUTO_TRIES)) {
      const got = await downloadCandidate(cand, {
        type,
        season: season ? Number(season) : undefined,
        episode: episode ? Number(episode) : undefined,
      });
      if (got) return NextResponse.json({ ...got, label: cand.label, fileId: cand.fileId });
    }
    return NextResponse.json({ error: "no subtitles found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "subtitle lookup failed" },
      { status: 502 }
    );
  }
}
