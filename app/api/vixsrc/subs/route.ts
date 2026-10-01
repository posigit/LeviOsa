import { NextRequest, NextResponse } from "next/server";
import { srtToVtt } from "@/lib/player-subs";

/**
 * OpenSubtitles (opensubtitles.com) subtitle lookup, gated on env:
 *   OPENSUBTITLES_API_KEY  — required (free account: https://opensubtitles.com)
 *   OPENSUBTITLES_USERNAME / OPENSUBTITLES_PASSWORD — optional; without them we
 *     still search, but the download endpoint needs an auth token, so set both.
 *
 * GET ?imdbId=&season=&episode=&lang=en
 *   → downloads best English sub as VTT (legacy Auto cascade)
 * GET ?imdbId=&list=1
 *   → { items: [{ fileId, label, downloads, format }] }  (no download quota hit)
 * GET ?imdbId=&fileId=12345
 *   → downloads that specific file as VTT
 */
export const dynamic = "force-dynamic";

const OS_BASE = "https://api.opensubtitles.com/api/v1";
/** Only surface the top N ranked English files in the player picker. */
const LIST_LIMIT = 3;

// In-memory token cache (per serverless instance; re-login on cold start).
let cachedToken: { token: string; expiresAt: number } | null = null;

type OsSubRow = {
  attributes?: {
    files?: Array<{ file_id?: number; file_name?: string }>;
    sub_format?: string;
    language?: string;
    download_count?: number;
    release_name?: string;
    feature_details?: { title?: string; movie_name?: string };
  };
};

async function getToken(): Promise<string> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!apiKey) throw new Error("OPENSUBTITLES_API_KEY not configured");
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  if (!username || !password) {
    throw new Error("OPENSUBTITLES_USERNAME/PASSWORD not configured");
  }

  const res = await fetch(`${OS_BASE}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": apiKey,
      "User-Agent": "tvtime-app",
    },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`opensubtitles login ${res.status}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("opensubtitles login returned no token");
  cachedToken = { token: data.token, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
  return data.token;
}

function englishSubs(rows: OsSubRow[]): OsSubRow[] {
  return rows.filter(
    (s) =>
      s.attributes?.files?.[0]?.file_id &&
      (s.attributes.language ?? "").toLowerCase().startsWith("en")
  );
}

function rankSubs(subs: OsSubRow[]): OsSubRow[] {
  return [...subs].sort((a, b) => {
    const fmt = (f?: string) => (f === "vtt" ? 0 : f === "srt" ? 1 : 2);
    const aFmt = fmt(a.attributes?.sub_format);
    const bFmt = fmt(b.attributes?.sub_format);
    if (aFmt !== bFmt) return aFmt - bFmt;
    return (b.attributes?.download_count ?? 0) - (a.attributes?.download_count ?? 0);
  });
}

function labelFor(row: OsSubRow): string {
  const release = row.attributes?.release_name?.trim();
  if (release) return release.slice(0, 80);
  const file = row.attributes?.files?.[0]?.file_name?.trim();
  if (file) return file.slice(0, 80);
  return "OpenSubtitles (English)";
}

async function searchSubs(
  imdbId: string,
  lang: string,
  season: string | null,
  episode: string | null,
  token: string,
  apiKey: string
): Promise<OsSubRow[]> {
  const searchParams = new URLSearchParams({
    imdb_id: imdbId.replace(/^tt/, ""),
    languages: lang,
    order_download_count: "desc",
  });
  if (season && episode) {
    searchParams.set("season_number", season);
    searchParams.set("episode_number", episode);
  }
  const searchRes = await fetch(`${OS_BASE}/subtitles?${searchParams}`, {
    headers: {
      "Api-Key": apiKey,
      Authorization: `Bearer ${token}`,
      "User-Agent": "tvtime-app",
    },
    cache: "no-store",
  });
  if (!searchRes.ok) throw new Error(`opensubtitles search ${searchRes.status}`);
  const search = (await searchRes.json()) as { data?: OsSubRow[] };
  return rankSubs(englishSubs(search.data ?? []));
}

async function downloadFileId(
  fileId: number,
  preferVtt: boolean,
  token: string,
  apiKey: string
): Promise<{ vtt: string }> {
  const dlRes = await fetch(`${OS_BASE}/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": apiKey,
      Authorization: `Bearer ${token}`,
      "User-Agent": "tvtime-app",
    },
    body: JSON.stringify({ file_id: fileId }),
    cache: "no-store",
  });
  if (!dlRes.ok) throw new Error(`opensubtitles download ${dlRes.status}`);
  const dl = (await dlRes.json()) as { link?: string };
  if (!dl.link) throw new Error("opensubtitles download returned no link");

  const fileRes = await fetch(dl.link, { cache: "no-store" });
  if (!fileRes.ok) throw new Error(`subtitle file ${fileRes.status}`);
  const raw = await fileRes.text();
  const looksVtt =
    preferVtt ||
    raw.trimStart().toUpperCase().startsWith("WEBVTT") ||
    raw.includes("-->");
  // Prefer conversion for classic SRT (comma millis).
  const isSrt = /(\d{2}:\d{2}:\d{2}),(\d{3})/.test(raw);
  const vtt = isSrt
    ? srtToVtt(raw)
    : looksVtt
      ? raw.replace(/^\uFEFF/, "")
      : srtToVtt(raw);
  return { vtt };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const imdbId = sp.get("imdbId");
  const season = sp.get("season");
  const episode = sp.get("episode");
  const lang = sp.get("lang") || "en";
  const listOnly = sp.get("list") === "1" || sp.get("list") === "true";
  const fileIdParam = sp.get("fileId");

  if (!imdbId) {
    return NextResponse.json({ error: "imdbId required" }, { status: 400 });
  }
  if (!process.env.OPENSUBTITLES_API_KEY) {
    return NextResponse.json(
      { error: "OpenSubtitles not configured" },
      { status: 501 }
    );
  }

  try {
    const token = await getToken();
    const apiKey = process.env.OPENSUBTITLES_API_KEY!;

    // Download a specific file the user picked from the list.
    if (fileIdParam) {
      const fileId = Number(fileIdParam);
      if (!Number.isFinite(fileId) || fileId <= 0) {
        return NextResponse.json({ error: "invalid fileId" }, { status: 400 });
      }
      const { vtt } = await downloadFileId(fileId, false, token, apiKey);
      return NextResponse.json({
        vtt,
        label: sp.get("label") || `OpenSubtitles #${fileId}`,
        fileId,
      });
    }

    const ranked = await searchSubs(imdbId, lang, season, episode, token, apiKey);
    if (ranked.length === 0) {
      return NextResponse.json({ error: "no subtitles found" }, { status: 404 });
    }

    // List mode: return choices without consuming a download.
    if (listOnly) {
      const seen = new Set<number>();
      const items: {
        fileId: number;
        label: string;
        downloads: number;
        format: string;
      }[] = [];
      for (const row of ranked) {
        const fileId = row.attributes?.files?.[0]?.file_id;
        if (!fileId || seen.has(fileId)) continue;
        seen.add(fileId);
        items.push({
          fileId,
          label: labelFor(row),
          downloads: row.attributes?.download_count ?? 0,
          format: row.attributes?.sub_format ?? "srt",
        });
        if (items.length >= LIST_LIMIT) break;
      }
      return NextResponse.json({ items });
    }

    // Legacy: download best match (Auto cascade).
    const best = ranked[0];
    const fileId = best.attributes?.files?.[0]?.file_id;
    if (!fileId) throw new Error("subtitle file has no file_id");
    const preferVtt = best.attributes?.sub_format === "vtt";
    const { vtt } = await downloadFileId(fileId, preferVtt, token, apiKey);
    return NextResponse.json({
      vtt,
      label: labelFor(best),
      fileId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "subtitle lookup failed" },
      { status: 502 }
    );
  }
}
