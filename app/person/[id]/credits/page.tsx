import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { getPersonSeenIds } from "@/lib/explore-digest";
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
import { cn } from "@/lib/utils";

/** Nothing is hidden — the full credit list, newest release first. */
const MAX_ROWS = 200;

type Kind = "all" | "movies" | "shows" | "in";

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

function CreditSection({
  title,
  emptyCopy,
  items,
}: {
  title: string;
  emptyCopy: string;
  items: PersonCredit[];
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
        {title}
        <span className="ml-2 text-base font-semibold text-white/40">
          {items.length}
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {emptyCopy}
        </p>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {items.map((c) => (
            <CreditRow key={c.href + c.title} credit={c} />
          ))}
        </div>
      )}
    </section>
  );
}

export default async function PersonCreditsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string | string[] }>;
}) {
  const { id: raw } = await params;
  const { kind: rawKind } = await searchParams;
  const personId = Number(raw);
  if (!Number.isFinite(personId)) notFound();

  const kindParam = Array.isArray(rawKind) ? rawKind[0] : rawKind;
  const kind: Kind =
    kindParam === "movies"
      ? "movies"
      : kindParam === "shows"
        ? "shows"
        : kindParam === "in"
          ? "in"
          : "all";

  const userId = await requireAuth();
  const [details, credits, seenIds] = await Promise.all([
    getPersonDetails(personId).catch(() => null),
    getPersonCombinedCredits(personId).catch(() => ({ cast: [], crew: [] })),
    getPersonSeenIds(userId),
  ]);
  if (!details) notFound();

  const unique = new Map<string, TmdbCombinedCredit>();
  for (const c of [...credits.cast, ...credits.crew]) {
    unique.set(`${isTv(c) ? "tv" : "movie"}-${c.id}`, c);
  }

  const seen = (c: TmdbCombinedCredit) =>
    isTv(c)
      ? seenIds.watchedShowIds.has(c.id)
      : seenIds.watchedMovieIds.has(c.id);

  const movies = newestFirst(
    [...unique.values()].filter((c) => !isTv(c))
  ).map(toCredit);
  const shows = newestFirst([...unique.values()].filter(isTv)).map(toCredit);
  const inLibrary = newestFirst([...unique.values()].filter(seen)).map(toCredit);

  const base = `/person/${personId}/credits`;
  const tabs: { key: Kind; label: string; href: string; count: number }[] = [
    { key: "all", label: "All", href: base, count: movies.length + shows.length },
    { key: "movies", label: "Movies", href: `${base}?kind=movies`, count: movies.length },
    { key: "shows", label: "Shows", href: `${base}?kind=shows`, count: shows.length },
  ];
  if (inLibrary.length > 0) {
    tabs.push({
      key: "in",
      label: "In Library",
      href: `${base}?kind=in`,
      count: inLibrary.length,
    });
  }

  const showMovies = kind === "all" || kind === "movies";
  const showShows = kind === "all" || kind === "shows";

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
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-black tracking-tight text-white">
              {details.name}
            </h1>
            <p className="text-xs text-white/45">Filmography</p>
          </div>
        </div>

        <nav
          aria-label="Filmography filter"
          className="mt-3 flex gap-1.5"
        >
          {tabs.map((t) => {
            const active = t.key === kind;
            return (
              <Link
                key={t.key}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-bold transition active:scale-[0.97]",
                  active
                    ? "bg-primary text-black"
                    : "text-white/55 hover:text-white"
                )}
              >
                <span className="truncate">{t.label}</span>
                <span
                  className={cn(
                    "text-[11px] font-black tabular-nums",
                    active ? "text-black/55" : "text-white/35"
                  )}
                >
                  {t.count}
                </span>
              </Link>
            );
          })}
        </nav>
      </StickyChrome>

      <div className="px-4 pt-4">
        {kind === "in" && (
          <CreditSection
            title="In Library"
            emptyCopy="Nothing from this filmography is in your library yet."
            items={inLibrary}
          />
        )}
        {showMovies && (
          <CreditSection
            title="Movies"
            emptyCopy="No movie credits found."
            items={movies}
          />
        )}
        {showShows && (
          <CreditSection
            title="Shows"
            emptyCopy="No series credits found."
            items={shows}
          />
        )}
      </div>
    </div>
  );
}
