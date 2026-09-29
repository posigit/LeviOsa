import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { getLibraryState } from "@/lib/explore-digest";
import { discoverMoviesByDecade } from "@/lib/tmdb";
import { getImdbDecadePage } from "@/lib/imdb-rankings";
import { RankedGrid } from "@/components/ranked-grid";
import { StickyChrome } from "@/components/sticky-chrome";

function parseDecade(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})s$/);
  const start = Number(m?.[1]);
  const now = new Date().getFullYear();
  if (!Number.isInteger(start) || start % 10 !== 0) return null;
  if (start < 1900 || start > now) return null;
  return start;
}

export default async function DecadePage({
  params,
}: {
  params: Promise<{ decade: string }>;
}) {
  const { decade: raw } = await params;
  const start = parseDecade(raw);
  if (start == null) notFound();

  const userId = await requireAuth();
  // IMDb order first (merged year files, Bayesian-weighted) — TMDB when incomplete.
  const [imdb, library] = await Promise.all([
    getImdbDecadePage(start, 1).catch(() => null),
    getLibraryState(userId),
  ]);
  const tmdb =
    imdb == null
      ? await discoverMoviesByDecade(start, 1).catch(() => ({
          items: [],
          totalPages: 1,
          totalResults: 0,
        }))
      : null;
  const data = imdb ?? tmdb!;
  const source: "imdb" | "tmdb" = imdb != null ? "imdb" : "tmdb";

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
              Best of the decade
            </p>
            <h1 className="truncate text-lg font-black tabular-nums text-white">
              {start}s
            </h1>
          </div>
        </div>
      </StickyChrome>

      <div className="px-4 pt-3">
        <p className="mb-3 text-xs font-semibold text-white/40">
          {data.totalResults > 0
            ? `${data.totalResults} films ranked by ${source === "imdb" ? "IMDb" : "TMDB"} score`
            : "Top-rated films from this decade"}
        </p>

        <RankedGrid
          kind="decade"
          value={`${start}s`}
          initialItems={data.items}
          initialStatuses={Object.fromEntries(library.movieStatusById)}
          totalPages={data.totalPages}
          totalResults={data.totalResults}
          showYear
          emptyLabel={`Nothing ranked for the ${start}s yet. Check back later.`}
        />
      </div>
    </div>
  );
}
