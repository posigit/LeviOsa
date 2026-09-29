import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { getLibraryState } from "@/lib/explore-digest";
import { discoverMoviesByYear } from "@/lib/tmdb";
import { getImdbYearPage } from "@/lib/imdb-rankings";
import { RankedGrid } from "@/components/ranked-grid";
import { StickyChrome } from "@/components/sticky-chrome";

function parseYear(raw: string | undefined): number | null {
  const y = Number(raw);
  const now = new Date().getFullYear();
  if (!Number.isInteger(y) || y < 1900 || y > now + 1) return null;
  return y;
}

export default async function YearPage({
  params,
}: {
  params: Promise<{ year: string }>;
}) {
  const { year: raw } = await params;
  const year = parseYear(raw);
  if (year == null) notFound();

  const userId = await requireAuth();
  // IMDb order first (Bayesian-weighted, 10K vote floor) — TMDB when no file.
  const [imdb, library] = await Promise.all([
    getImdbYearPage(year, 1).catch(() => null),
    getLibraryState(userId),
  ]);
  const tmdb =
    imdb == null
      ? await discoverMoviesByYear(year, 1).catch(() => ({
          items: [],
          totalPages: 1,
          totalResults: 0,
        }))
      : null;
  const data = imdb ?? tmdb!;
  const source: "imdb" | "tmdb" = imdb != null ? "imdb" : "tmdb";

  const decadeStart = Math.floor(year / 10) * 10;

  return (
    <div className="min-h-dvh bg-black pb-nav-page">
      <StickyChrome contentClassName="px-4 pt-2 pb-2">
        <div className="flex items-center gap-3">
          <Link
            href="/movies"
            aria-label="Back to movies"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">
              Best of the year
            </p>
            <h1 className="truncate text-lg font-black tabular-nums text-white">
              {year}
            </h1>
          </div>
        </div>
      </StickyChrome>

      <div className="px-4 pt-3">
        <p className="mb-3 text-xs font-semibold text-white/40">
          {data.totalResults > 0
            ? `${data.totalResults} films ranked by ${source === "imdb" ? "IMDb" : "TMDB"} score`
            : "Top-rated films from this year"}
        </p>

        <RankedGrid
          kind="year"
          value={String(year)}
          initialItems={data.items}
          initialStatuses={Object.fromEntries(library.movieStatusById)}
          totalPages={data.totalPages}
          totalResults={data.totalResults}
          showYear={false}
          emptyLabel={`Nothing ranked for ${year} yet. Check back later.`}
        />

        <Link
          href={`/movie/decade/${decadeStart}s`}
          className="mb-6 mt-4 flex items-center justify-center gap-1 text-xs font-semibold text-white/35 transition hover:text-white/70"
        >
          More from the {decadeStart}s
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
