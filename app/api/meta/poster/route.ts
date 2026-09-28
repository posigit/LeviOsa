import { auth } from "@/lib/auth";
import { getMovieDetails, getTvDetails } from "@/lib/tmdb";
import { NextResponse } from "next/server";

/**
 * Poster path lookup for offline thumbnails. The browser must not call TMDB
 * with a key, and there is no poster on a download record older than this
 * feature — the Library asks here once per title while it is online, then
 * caches the tiny image next to the download's bytes.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const id = Number(searchParams.get("id"));
  if ((type !== "movie" && type !== "tv") || !Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ posterPath: null });
  }

  try {
    const details =
      type === "movie" ? await getMovieDetails(id) : await getTvDetails(id);
    return NextResponse.json({ posterPath: details?.poster_path ?? null });
  } catch {
    return NextResponse.json({ posterPath: null });
  }
}
