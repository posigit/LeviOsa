import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronLeft, Star } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { getLibraryState } from "@/lib/explore-digest";
import {
  getPersonDetails,
  getPersonMovieCredits,
  posterUrl,
  type TmdbPersonMovieCredit,
} from "@/lib/tmdb";
import { MovieWatchButton } from "@/components/movie-watch-button";

function score(v?: number) {
  if (v == null || v <= 0) return "–";
  return v.toFixed(1);
}

/** Best-first ranking: meaningful vote volume first (50+), then score,
 * then vote count, then popularity. Single-vote 10.0 shorts sink instead
 * of floating above real films. Nothing hidden — just ordered honestly. */
function rankCredits(list: TmdbPersonMovieCredit[]): TmdbPersonMovieCredit[] {
  return [...list]
    .filter((c) => c.title || c.name)
    .sort((a, b) => {
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

function CreditCard({
  credit,
  role,
  status,
}: {
  credit: TmdbPersonMovieCredit;
  role?: string;
  status: string | null;
}) {
  const poster = posterUrl(credit.poster_path, "w342");
  const year = credit.release_date?.slice(0, 4);
  return (
    <div className="min-w-0">
      <Link
        href={`/movie/${credit.id}`}
        className="relative block aspect-[2/3] overflow-hidden rounded-md bg-card ring-1 ring-white/10"
      >
        {poster ? (
          <Image
            src={poster}
            alt={credit.title ?? credit.name ?? "Film"}
            fill
            sizes="(max-width: 480px) 33vw, 200px"
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-2 text-center text-xs font-bold text-white/50">
            {credit.title ?? credit.name}
          </div>
        )}
      </Link>
      <Link href={`/movie/${credit.id}`} className="mt-1 block min-w-0">
        <p className="truncate text-xs font-bold text-white">
          {credit.title ?? credit.name}
        </p>
      </Link>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <span className="inline-flex min-w-0 items-center gap-0.5 text-[11px] font-semibold text-white/60">
          <Star className="h-3 w-3 shrink-0 fill-primary text-primary" />
          {score(credit.vote_average)}
          {year ? <span className="ml-1 truncate text-white/40">{year}</span> : null}
        </span>
        <MovieWatchButton
          tmdbId={credit.id}
          initialStatus={status}
          variant="compact"
        />
      </div>
      {role ? (
        <p className="mt-0.5 truncate text-[11px] text-white/40">{role}</p>
      ) : null}
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
  const [details, credits, library] = await Promise.all([
    getPersonDetails(personId).catch(() => null),
    getPersonMovieCredits(personId).catch(() => ({ cast: [], crew: [] })),
    getLibraryState(userId),
  ]);
  if (!details) notFound();

  const acting = rankCredits(credits.cast).slice(0, 30);
  const directing = rankCredits(
    credits.crew.filter((c) => c.job === "Director" || c.department === "Directing")
  ).slice(0, 12);
  const knownFor = acting.slice(0, 6);

  const photo = posterUrl(details.profile_path, "original");
  const birthYear = details.birthday?.slice(0, 4);
  const knownForTitles = knownFor
    .map((c) => c.title ?? c.name)
    .filter(Boolean);

  /** Hero meta line: born, birthplace, then the credit counts. */
  const facts = [
    birthYear ? `Born ${birthYear}` : null,
    details.place_of_birth || null,
    `${acting.length} film${acting.length === 1 ? "" : "s"}`,
    directing.length > 0 ? `${directing.length} directed` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="min-h-dvh bg-black pb-nav-page">
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

        {/* Hero footer: department -> name -> facts -> known for */}
        <div className="absolute inset-x-0 bottom-0 px-5 pb-6 text-center">
          <span className="glass-control inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/90">
            {details.known_for_department ?? "Filmography"}
          </span>

          <h1 className="mt-3 px-4 text-4xl font-black tracking-tight text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.9)]">
            {details.name}
          </h1>

          {facts.length > 0 && (
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
          )}

          {knownForTitles.length > 0 && (
            <p className="mx-auto mt-3 max-w-md text-[13px] leading-snug text-white/55">
              Known for {knownForTitles.join(", ")}
            </p>
          )}
        </div>
      </div>

      {/* ---------- Biography ---------- */}
      {details.biography ? (
        <section className="px-4 pt-7">
          <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
            Biography
          </h2>
          <p className="line-clamp-6 text-sm leading-relaxed text-white/75">
            {details.biography}
          </p>
        </section>
      ) : null}

      {/* ---------- Known for ---------- */}
      {knownFor.length > 0 && (
        <section className="px-4 pt-7">
          <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
            Known for
          </h2>
          <div className="grid grid-cols-3 gap-x-2 gap-y-4">
            {knownFor.map((c) => (
              <CreditCard
                key={`known-${c.id}-${c.character ?? ""}`}
                credit={c}
                role={c.character}
                status={library.movieStatusById.get(c.id) || null}
              />
            ))}
          </div>
        </section>
      )}

      {/* ---------- Directed ---------- */}
      {directing.length > 0 && (
        <section className="px-4 pt-7">
          <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
            Directed
          </h2>
          <div className="grid grid-cols-3 gap-x-2 gap-y-4">
            {directing.map((c) => (
              <CreditCard
                key={`dir-${c.id}`}
                credit={c}
                status={library.movieStatusById.get(c.id) || null}
              />
            ))}
          </div>
        </section>
      )}

      {/* ---------- Filmography ---------- */}
      <section className="px-4 pt-7 pb-4">
        <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
          {directing.length > 0 ? "Acting" : "Filmography"}
        </h2>
        {acting.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No film credits found.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-x-2 gap-y-4">
            {acting.map((c) => (
              <CreditCard
                key={`cast-${c.id}-${c.character ?? ""}`}
                credit={c}
                role={c.character}
                status={library.movieStatusById.get(c.id) || null}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}