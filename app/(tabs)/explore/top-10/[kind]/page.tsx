import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronLeft } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { loadTopTenChart, type TopTenKind } from "@/lib/explore-data";
import {
  backdropUrl,
  posterUrl,
  type TmdbMediaCard,
} from "@/lib/tmdb";
import { ShowFollowButton } from "@/components/show-follow-button";
import { MovieWatchButton } from "@/components/movie-watch-button";
import { StickyChrome } from "@/components/sticky-chrome";
import { cn } from "@/lib/utils";

function parseKind(raw: string | undefined): TopTenKind | null {
  if (raw === "shows" || raw === "movies") return raw;
  return null;
}

function Rank({
  rank,
  gold,
  className,
}: {
  rank: number;
  gold?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "top-ten-rank select-none",
        gold && "top-ten-rank-gold",
        className
      )}
      aria-hidden
    >
      {rank}
    </span>
  );
}

function scoreLabel(vote?: number) {
  if (vote == null || vote <= 0) return null;
  return vote.toFixed(1);
}

function ChartRow({
  item,
  rank,
  owned,
  movieStatus,
}: {
  item: TmdbMediaCard;
  rank: number;
  owned: boolean;
  movieStatus?: string | null;
}) {
  const href = item.mediaType === "tv" ? `/show/${item.id}` : `/movie/${item.id}`;
  const score = scoreLabel(item.vote_average);

  return (
    <article className="relative flex items-center gap-2 border-b border-white/[0.07] py-3">
      <div className="relative w-14 flex-shrink-0 text-center">
        <Rank
          rank={rank}
          gold={rank <= 3}
          className={cn(
            "inline-block",
            rank === 10 ? "text-[2.35rem]" : "text-[2.85rem]"
          )}
        />
      </div>
      <Link
        href={href}
        className="relative h-[5.35rem] w-[3.55rem] flex-shrink-0 overflow-hidden rounded-lg bg-secondary ring-1 ring-white/10"
      >
        {item.poster_path ? (
          <Image
            src={posterUrl(item.poster_path, "w185") ?? ""}
            alt=""
            fill
            sizes="57px"
            className="object-cover"
          />
        ) : null}
      </Link>
      <Link href={href} className="min-w-0 flex-1 py-0.5">
        <p className="text-[15px] font-black leading-snug text-white">
          {item.title}
        </p>
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {item.mediaType === "tv" ? "Series" : "Film"}
          {score ? ` · TMDB ${score}` : ""}
          {owned ? " · In library" : ""}
        </p>
      </Link>
      <div className="flex-shrink-0">
        {item.mediaType === "tv" ? (
          <ShowFollowButton
            tmdbId={item.id}
            initialFollowing={owned}
            variant="compact"
          />
        ) : (
          <MovieWatchButton
            tmdbId={item.id}
            initialStatus={movieStatus ?? null}
            variant="compact"
          />
        )}
      </div>
    </article>
  );
}

export default async function TopTenPage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind: raw } = await params;
  const kind = parseKind(raw);
  if (!kind) notFound();

  const userId = await requireAuth();
  const { items, library } = await loadTopTenChart(userId, kind);
  const [lead, ...rest] = items;
  const series = kind === "shows";
  const title = series ? "Top 10 Series" : "Top 10 Movies";
  const ownedLead = lead
    ? series
      ? library.followedShowIds.has(lead.id)
      : library.ownedMovieIds.has(lead.id)
    : false;

  const leadHref = lead
    ? series
      ? `/show/${lead.id}`
      : `/movie/${lead.id}`
    : "/explore";
  const bg = lead
    ? backdropUrl(lead.backdrop_path, "w780") ||
      posterUrl(lead.poster_path, "w500")
    : null;

  return (
    <div className="min-h-dvh bg-black pb-nav-page">
      <StickyChrome contentClassName="px-4 pt-2 pb-2">
        <div className="flex items-center gap-3">
          <Link
            href="/explore"
            aria-label="Back to Explore"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">
              This week
            </p>
            <h1 className="truncate text-lg font-black text-white">{title}</h1>
          </div>
        </div>
      </StickyChrome>

      {lead && (
        <section className="relative mb-2 overflow-hidden">
          <Link href={leadHref} className="block">
            <div className="relative h-[19.5rem] w-full">
              {bg ? (
                <Image
                  src={bg}
                  alt=""
                  fill
                  priority
                  sizes="100vw"
                  className="object-cover object-top"
                />
              ) : (
                <div className="h-full w-full bg-secondary" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/55 to-black/15" />
            </div>
          </Link>
          <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 px-4 pb-5">
            <Rank rank={1} gold className="text-[6.5rem] leading-none" />
            <div className="mb-1 min-w-0 flex-1">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-primary">
                Number one
              </p>
              <Link href={leadHref}>
                <h2 className="mt-0.5 line-clamp-2 text-[1.55rem] font-black leading-[1.05] text-white drop-shadow">
                  {lead.title}
                </h2>
              </Link>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {series ? (
                  <ShowFollowButton
                    tmdbId={lead.id}
                    initialFollowing={ownedLead}
                    variant="compact"
                  />
                ) : (
                  <MovieWatchButton
                    tmdbId={lead.id}
                    initialStatus={
                      library.movieStatusById.get(lead.id) || null
                    }
                    variant="compact"
                  />
                )}
                <Link
                  href={leadHref}
                  className="rounded-full bg-white/15 px-3 py-1.5 text-[11px] font-bold text-white backdrop-blur-sm"
                >
                  Details
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="px-4">
        {rest.map((item, i) => {
          const rank = i + 2;
          const owned = series
            ? library.followedShowIds.has(item.id)
            : library.ownedMovieIds.has(item.id);
          return (
            <ChartRow
              key={`${item.mediaType}-${item.id}`}
              item={item}
              rank={rank}
              owned={owned}
              movieStatus={
                series ? null : library.movieStatusById.get(item.id) || null
              }
            />
          );
        })}
        {items.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Chart is warming up. Check back in a minute.
          </p>
        )}
      </div>
    </div>
  );
}
