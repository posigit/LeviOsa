import { cookies } from "next/headers";
import { requireAuth } from "@/lib/auth";
import {
  EXPLORE_TAB_COOKIE,
  resolveExploreTab,
  type ExploreTab,
} from "@/lib/explore-tab";
import { loadExploreDiscover, loadExploreFeed } from "@/lib/explore-data";
import { SearchBar } from "@/components/search-bar";
import { StickyChrome } from "@/components/sticky-chrome";
import { ExplorePills } from "@/components/explore-pills";
import { DiscoverRail } from "@/components/discover-rail";
import { FeedHero } from "@/components/feed-hero";
import { DiscoverGenreBrowser } from "@/components/discover-genre-browser";
import { DailyPickCard } from "@/components/daily-pick";
import { TopTenRail } from "@/components/top-ten";
import { TonightStrip } from "@/components/tonight-strip";
import { ContinueWatchingRail } from "@/components/continue-watching";
import { SectionLabel } from "@/components/section-label";
import { posterUrl } from "@/lib/tmdb";
import Link from "next/link";
import Image from "next/image";

/** Poster tile — deliberately control-free: the whole tile is the link. */
function PosterTile({
  title,
  posterPath,
  href,
}: {
  title: string;
  posterPath?: string | null;
  href: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg bg-card">
      <Link href={href}>
        <div style={{ aspectRatio: "2 / 3" }} className="relative bg-secondary">
          {posterPath ? (
            <Image
              src={posterUrl(posterPath, "w342") ?? ""}
              alt={title}
              fill
              sizes="(max-width: 768px) 33vw, 200px"
              className="object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
              {title}
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}

function GridSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3">
        <SectionLabel>{label}</SectionLabel>
      </div>
      <div className="grid grid-cols-3 gap-2">{children}</div>
    </section>
  );
}

async function FeedBody({ userId }: { userId: string }) {
  const data = await loadExploreFeed(userId);
  const { digest, library, continueWatching, tonight, topShows, topMovies } =
    data;
  const pick = digest.dailyPick;
  const forYou = digest.forYou;

  /** The hero carries the head of the personal stack; the rail keeps the tail. */
  const heroItems = (forYou.length >= 3 ? forYou : topShows).slice(0, 6);
  const heroKicker = forYou.length >= 3 ? "For you" : "Trending now";
  const forYouTail = forYou.slice(6);

  return (
    <>
      <FeedHero items={heroItems} kicker={heroKicker} />

      <ContinueWatchingRail items={continueWatching} />
      <TonightStrip items={tonight} />

      {pick && (
        <DailyPickCard
          pick={pick}
          following={
            pick.item.mediaType === "tv"
              ? library.followedShowIds.has(pick.item.id)
              : false
          }
          movieStatus={
            pick.item.mediaType === "movie"
              ? library.movieStatusById.get(pick.item.id) || null
              : null
          }
        />
      )}

      {forYouTail.length > 3 && (
        <DiscoverRail
          heading="pill"
          label="More for you"
          items={forYouTail}
        />
      )}

      {digest.because.slice(0, 2).map((rail) => (
        <DiscoverRail
          heading="pill"
          key={rail.seedTitle}
          label={`Because you watched ${rail.seedTitle}`}
          items={rail.items}
        />
      ))}

      <TopTenRail
        label="Top 10 Series"
        kicker="Hottest this week"
        href="/explore/top-10/shows"
        items={topShows}
        ownedIds={library.followedShowIds}
        priority
        featured
      />

      <TopTenRail
        label="Top 10 Movies"
        href="/explore/top-10/movies"
        items={topMovies}
        ownedIds={library.ownedMovieIds}
      />
    </>
  );
}

async function DiscoverBody({ userId }: { userId: string }) {
  const data = await loadExploreDiscover(userId);

  /** Trending series and films share the featured stage. */
  const heroItems = [
    ...data.hotMovies.slice(0, 3),
    ...data.popularTv.slice(0, 3),
  ].slice(0, 6);

  return (
    <>
      <FeedHero items={heroItems} kicker="Trending now" />

      <p className="mb-5 text-center text-xs text-muted-foreground">
        Find something new - not already in your library
      </p>

      {/* Browse first: this tab is for searching the whole catalog. */}
      <DiscoverGenreBrowser
        genres={data.genreChips}
      />

      {/* What is hot right now */}
      <DiscoverRail
        heading="pill"
        label="Hot movies this week"
        items={data.hotMovies}
      />
      <DiscoverRail
        heading="pill"
        label="Popular series"
        items={data.popularTv}
      />
      <DiscoverRail
        heading="pill"
        label="Hidden gems"
        items={data.hiddenGems}
      />

      {/* Theatrical window */}
      <DiscoverRail
        heading="pill"
        label="In theaters now"
        items={data.nowPlaying}
      />
      <DiscoverRail
        heading="pill"
        label="Coming to theaters"
        items={data.upcoming}
      />

      {/* Broadcast schedule */}
      {data.airingToday.length > 0 && (
        <GridSection label="Airing Today">
          {data.airingToday.map((show) => (
            <PosterTile
              key={show.id}
              title={show.title}
              posterPath={show.poster_path}
              href={`/show/${show.id}`}
            />
          ))}
        </GridSection>
      )}

      {data.onTheAir.length > 0 && (
        <GridSection label="On The Air">
          {data.onTheAir.map((show) => (
            <PosterTile
              key={show.id}
              title={show.title}
              posterPath={show.poster_path}
              href={`/show/${show.id}`}
            />
          ))}
        </GridSection>
      )}

      <DiscoverRail
        heading="pill"
        label="Critically loved films"
        items={data.topMovies}
      />
    </>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore — TV Time",
  description: "Discover trending shows, top 10, and tonight's premieres.",
};

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await requireAuth();
  const { tab: tabParam } = await searchParams;
  const cookieStore = await cookies();
  const tab: ExploreTab = resolveExploreTab(
    tabParam,
    cookieStore.get(EXPLORE_TAB_COOKIE)?.value
  );

  return (
    <div className="min-h-dvh bg-background pb-nav-page">
      <StickyChrome contentClassName="px-4 pt-3 pb-1">
        <SearchBar />
      </StickyChrome>
      <div className="px-4 pt-1">
        <ExplorePills active={tab} />
        <div className="pt-3">
          {tab === "discover" ? (
            <DiscoverBody userId={userId} />
          ) : (
            <FeedBody userId={userId} />
          )}
        </div>
      </div>
    </div>
  );
}
