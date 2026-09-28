import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { getPersonSeenIds } from "@/lib/explore-digest";
import {
  getPersonDetails,
  getPersonCombinedCredits,
  posterUrl,
  type TmdbCombinedCredit,
} from "@/lib/tmdb";
import { PersonBiography } from "@/components/person-bio";
import {
  CreditRail,
  CreditRow,
  SeenStatCard,
  type PersonCredit,
} from "@/components/person-credits";

const PREVIEW = 6;

function isTv(c: TmdbCombinedCredit) {
  return c.media_type === "tv";
}

function creditDate(c: TmdbCombinedCredit): string | null {
  return (isTv(c) ? c.first_air_date : c.release_date) || null;
}

function creditKey(c: TmdbCombinedCredit) {
  return `${isTv(c) ? "tv" : "movie"}-${c.id}`;
}

/** Best-first ranking: meaningful vote volume first (50+), then score,
 * then vote count, then popularity. Single-vote 10.0 shorts sink instead
 * of floating above real films. Nothing hidden — just ordered honestly. */
function rankCredits(list: TmdbCombinedCredit[]): TmdbCombinedCredit[] {
  return [...list].sort((a, b) => {
    const aw = (a.vote_count ?? 0) >= 50 ? 0 : 1;
    const bw = (b.vote_count ?? 0) >= 50 ? 0 : 1;
    if (aw !== bw) return aw - bw;
    const sa = a.vote_average ?? 0;
    const sb = b.vote_average ?? 0;
    if (sb !== sa) return sb - sa;
    const ca = a.vote_count ?? 0;
    const cb = b.vote_count ?? 0;
    if (cb !== ca) return cb - ca;
    return (b.popularity ?? 0) - (a.popularity ?? 0);
  });
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

/** Filmography heading with a trailing "Show All" link. */
function SectionHeader({
  title,
  href,
  count,
}: {
  title: string;
  href?: string;
  count?: number;
}) {
  if (!href) {
    return (
      <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
        {title}
      </h2>
    );
  }
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-[22px] font-extrabold tracking-tight text-white">
        {title}
        {typeof count === "number" ? (
          <span className="ml-2 text-base font-semibold text-white/40">
            {count}
          </span>
        ) : null}
      </h2>
      <Link
        href={href}
        className="flex shrink-0 items-center gap-1 text-sm font-bold text-primary active:scale-95"
      >
        Show All
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const personId = Number(raw);
  if (!Number.isFinite(personId)) notFound();

  const userId = await requireAuth();
  const [details, credits, seenIds] = await Promise.all([
    getPersonDetails(personId).catch(() => null),
    getPersonCombinedCredits(personId).catch(() => ({ cast: [], crew: [] })),
    getPersonSeenIds(userId),
  ]);
  if (!details) notFound();

  const { cast, crew } = credits;

  /** Acting credits, split by medium. */
  const actingMovies = rankCredits(cast.filter((c) => !isTv(c)));
  const actingShows = rankCredits(cast.filter(isTv));

  /** Director credits, whichever medium they land in. */
  const directing = rankCredits(
    crew.filter((c) => c.job === "Director" || c.department === "Directing")
  );
  const directedMovies = directing.filter((c) => !isTv(c));
  const directedShows = directing.filter(isTv);

  /** Every distinct title this person is attached to — the "Seen" denominator. */
  const allTitles = new Map<string, TmdbCombinedCredit>();
  for (const c of [...cast, ...crew]) allTitles.set(creditKey(c), c);
  const totalCredits = allTitles.size;
  const seenCount = [...allTitles.values()].filter((c) =>
    isTv(c)
      ? seenIds.watchedShowIds.has(c.id)
      : seenIds.watchedMovieIds.has(c.id)
  ).length;

  const knownFor = rankCredits(cast).slice(0, 8);

  /** Not-yet-released work, soonest first. */
  const today = new Date().toISOString().slice(0, 10);
  const upcomingMap = new Map<string, TmdbCombinedCredit>();
  for (const c of [...cast, ...crew]) {
    const d = creditDate(c);
    if (d && d > today) upcomingMap.set(creditKey(c), c);
  }
  const comingSoon = [...upcomingMap.values()]
    .sort((a, b) => (creditDate(a) ?? "").localeCompare(creditDate(b) ?? ""))
    .slice(0, 8)
    .map(toCredit);

  const knownForCredits = knownFor.map(toCredit);
  const moviePreview = actingMovies.slice(0, PREVIEW).map(toCredit);
  const showPreview = actingShows.slice(0, PREVIEW).map(toCredit);
  const directedPreview = directedMovies
    .slice(0, PREVIEW)
    .map(toCredit)
    .concat(directedShows.slice(0, PREVIEW).map(toCredit));

  const photo = posterUrl(details.profile_path, "original");

  /** Hero meta line: department, then the medium split — matches the app's
   *  "Acting · 30 shows · 117 movies" convention. */
  const facts = [
    details.known_for_department ?? "Filmography",
    `${actingShows.length + directedShows.length} show${
      actingShows.length + directedShows.length === 1 ? "" : "s"
    }`,
    `${actingMovies.length + directedMovies.length} movie${
      actingMovies.length + directedMovies.length === 1 ? "" : "s"
    }`,
  ];

  const creditsHref = `/person/${personId}/credits`;

  return (
    <div className="min-h-dvh bg-black pb-safe-page">
      {/* ---------- Floating controls: stick over the scroll, like the app ---------- */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-40 px-4 top-safe-float">
        <div className="flex items-center justify-between">
          <Link
            href="/movies"
            aria-label="Back to movies"
            className="glass-control pointer-events-auto grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </div>
      </div>

      {/* ---------- Full-bleed photo hero ---------- */}
      <div className="relative isolate h-[72dvh] max-h-[720px] min-h-[460px] overflow-hidden">
        {photo ? (
          <Image
            src={photo}
            alt={details.name}
            fill
            sizes="100vw"
            className="object-cover object-top"
            priority
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-secondary to-black"
          >
            <span className="text-[26vw] font-black leading-none text-white/10">
              {details.name.charAt(0)}
            </span>
          </div>
        )}

        {/* Theme seam: keeps the bottom edge of the hero on true black. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 60% at 50% 100%, rgb(var(--theme) / 0.32), transparent 70%)",
          }}
        />

        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/75 via-black/35 to-transparent"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[58%]"
          style={{
            background:
              "linear-gradient(to top, #000 14%, rgb(0 0 0 / 0.82) 34%, rgb(0 0 0 / 0.45) 62%, transparent)",
          }}
        />

        {/* Hero footer: department -> name -> counts */}
        <div className="absolute inset-x-0 bottom-0 px-5 pb-6 text-center">
          <h1 className="text-4xl font-black tracking-tight text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.9)]">
            {details.name}
          </h1>

          <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-[15px] text-white/75">
            {facts.map((item, i) => (
              <span key={item} className="inline-flex items-center gap-2">
                {i > 0 && (
                  <span aria-hidden className="text-white/35">
                    {"\u00b7"}
                  </span>
                )}
                {item}
              </span>
            ))}
          </p>
        </div>
      </div>

      {/* ---------- Seen ---------- */}
      <SeenStatCard seen={seenCount} total={totalCredits} />

      {/* ---------- Biography ---------- */}
      {details.biography ? (
        <PersonBiography text={details.biography} />
      ) : null}

      {/* ---------- Coming soon ---------- */}
      {comingSoon.length > 0 && (
        <section className="px-4 pt-7">
          <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
            Coming Soon
          </h2>
          <div className="divide-y divide-white/[0.06]">
            {comingSoon.map((c) => (
              <CreditRow key={c.href + c.title} credit={c} />
            ))}
          </div>
        </section>
      )}

      {/* ---------- Known for ---------- */}
      {knownForCredits.length > 0 && (
        <section className="pt-7">
          <div className="px-4">
            <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
              Known For
            </h2>
          </div>
          <CreditRail items={knownForCredits} />
        </section>
      )}

      {/* ---------- Directed ---------- */}
      {directedPreview.length > 0 && (
        <section className="pt-7">
          <div className="px-4">
            <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
              Directed
            </h2>
          </div>
          <CreditRail items={directedPreview} />
        </section>
      )}

      {/* ---------- Filmography, split by medium ---------- */}
      <section className="px-4 pt-7">
        <SectionHeader
          title="Movies"
          href={moviePreview.length > 0 ? creditsHref : undefined}
          count={actingMovies.length + directedMovies.length}
        />
        {moviePreview.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No movie credits found.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {moviePreview.map((c) => (
              <CreditRow key={c.href + c.title} credit={c} />
            ))}
          </div>
        )}
      </section>

      <section className="px-4 pt-7">
        <SectionHeader
          title="Shows"
          href={showPreview.length > 0 ? creditsHref : undefined}
          count={actingShows.length + directedShows.length}
        />
        {showPreview.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No series credits found.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {showPreview.map((c) => (
              <CreditRow key={c.href + c.title} credit={c} />
            ))}
          </div>
        )}
      </section>

      {/* ---------- Footer link to the complete filmography ---------- */}
      {(actingMovies.length + actingShows.length) > PREVIEW * 2 ? (
        <div className="px-4 pt-7">
          <Link
            href={creditsHref}
            className="flex w-full items-center justify-center gap-1 rounded-full bg-card px-4 py-3 text-sm font-bold text-primary ring-1 ring-white/10 active:scale-[0.98]"
          >
            Show All Credits
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      ) : null}

      <div className="h-8" />
    </div>
  );
}
