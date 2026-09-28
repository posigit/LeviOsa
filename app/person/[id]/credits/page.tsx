import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import {
  getPersonCombinedCredits,
  getPersonDetails,
  posterUrl,
  type TmdbCombinedCredit,
} from "@/lib/tmdb";
import {
  CreditRow,
  type PersonCredit,
} from "@/components/person-credits";
import { StickyChrome } from "@/components/sticky-chrome";

/** Nothing is hidden — the full credit list, newest release first. */
const MAX_ROWS = 200;

function isTv(c: TmdbCombinedCredit) {
  return c.media_type === "tv";
}

function creditDate(c: TmdbCombinedCredit): string {
  return (isTv(c) ? c.first_air_date : c.release_date) || "";
}

function newestFirst(list: TmdbCombinedCredit[]) {
  return [...list]
    .filter((c) => c.title || c.name)
    .sort((a, b) => creditDate(b).localeCompare(creditDate(a)))
    .slice(0, MAX_ROWS);
}

function toCredit(c: TmdbCombinedCredit): PersonCredit {
  const tv = isTv(c);
  const date = creditDate(c);
  return {
    href: tv ? `/show/${c.id}` : `/movie/${c.id}`,
    poster: posterUrl(c.poster_path, "w342"),
    title: tv ? (c.name ?? "") : (c.title ?? ""),
    character: c.character?.trim() || c.job || null,
    year: date ? date.slice(0, 4) : null,
    episodeCount: tv ? (c.episode_count ?? null) : null,
  };
}

export default async function PersonCreditsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const personId = Number(raw);
  if (!Number.isFinite(personId)) notFound();

  await requireAuth();
  const [details, credits] = await Promise.all([
    getPersonDetails(personId).catch(() => null),
    getPersonCombinedCredits(personId).catch(() => ({ cast: [], crew: [] })),
  ]);
  if (!details) notFound();

  const unique = new Map<string, TmdbCombinedCredit>();
  for (const c of [...credits.cast, ...credits.crew]) {
    unique.set(`${isTv(c) ? "tv" : "movie"}-${c.id}`, c);
  }

  const movies = newestFirst(
    [...unique.values()].filter((c) => !isTv(c))
  ).map(toCredit);
  const shows = newestFirst([...unique.values()].filter(isTv)).map(toCredit);

  return (
    <div className="min-h-dvh bg-black pb-safe-page">
      <StickyChrome contentClassName="px-4 pt-3 pb-2">
        <div className="flex items-center gap-3">
          <Link
            href={`/person/${personId}`}
            aria-label="Back"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-xl font-black tracking-tight text-white">
            {details.name}
          </h1>
        </div>
      </StickyChrome>

      <div className="px-4 pt-4">
        <section className="mb-8">
          <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
            Movies
            <span className="ml-2 text-base font-semibold text-white/40">
              {movies.length}
            </span>
          </h2>
          {movies.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No movie credits found.
            </p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {movies.map((c) => (
                <CreditRow key={c.href + c.title} credit={c} />
              ))}
            </div>
          )}
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
            Shows
            <span className="ml-2 text-base font-semibold text-white/40">
              {shows.length}
            </span>
          </h2>
          {shows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No series credits found.
            </p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {shows.map((c) => (
                <CreditRow key={c.href + c.title} credit={c} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
