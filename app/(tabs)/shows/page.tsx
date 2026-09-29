import { cookies } from "next/headers";
import { requireAuth } from "@/lib/auth";
import { db, withDbRetry, mapPool } from "@/lib/db";
import {
  shows,
  userShows,
  watchedEpisodes,
  episodes,
} from "@/lib/schema";
import { eq, and, inArray } from "drizzle-orm";
import { ShowTabs } from "@/components/show-tabs";
import { StickyChrome } from "@/components/sticky-chrome";
import { SectionLabel } from "@/components/section-label";
import { ShowListItem, ShowListItemData } from "@/components/show-list-item";
import { ShowCard } from "@/components/show-card";
import { LayoutToggle } from "@/components/layout-toggle";
import {
  LEGACY_LAYOUT_COOKIE,
  layoutCookieName,
  resolveLayoutPref,
} from "@/lib/layout-pref";
import {
  belongsInWatchNext,
  computeNextEpisode,
  computeUpcomingEpisodes,
  effectiveLastWatchedAt,
  isCaughtUpFreshDrop,
  isEpisodeAired,
  makeWatchedKey,
  EpisodeInfo,
  WatchedKey,
} from "@/lib/show-progress";
import {
  daysUntilYmd,
  formatAppCalendarDate,
  toYmd,
} from "@/lib/app-time";
import { ensureEpisodes } from "@/lib/ensure";
import { UpcomingList, UpcomingGroup } from "@/components/upcoming-list";
import { OnboardingNudge } from "@/components/onboarding-nudge";
import Link from "next/link";
import { CalendarDays } from "lucide-react";

function dateKey(airDate: string): string {
  return toYmd(airDate) ?? airDate.slice(0, 10);
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shows — LeviOsa",
  description: "Your followed shows, watch next, and upcoming episodes.",
};

export default async function ShowsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; layout?: string }>;
}) {
  const { view, layout } = await searchParams;
  const currentView = view === "upcoming" ? "upcoming" : "watchlist";
  const cookieStore = await cookies();
  const layoutPref = resolveLayoutPref(
    layout,
    cookieStore.get(layoutCookieName("shows"))?.value,
    cookieStore.get(LEGACY_LAYOUT_COOKIE)?.value
  );
  const gridLayout = layoutPref === "grid";

  const userId = await requireAuth();

  // Retry: Railway cold starts / brief disconnects
  const userShowsList = await withDbRetry(() =>
    db
      .select({
        tmdbId: shows.tmdbId,
        title: shows.title,
        posterPath: shows.posterPath,
        status: userShows.status,
        lastSeason: userShows.lastSeason,
        lastEpisode: userShows.lastEpisode,
        lastWatchedAt: userShows.lastWatchedAt,
        followedAt: userShows.followedAt,
        updatedAt: userShows.updatedAt,
        numberOfSeasons: shows.numberOfSeasons,
      })
      .from(userShows)
      .innerJoin(shows, eq(userShows.tmdbId, shows.tmdbId))
      .where(eq(userShows.userId, userId))
  );

  const watching = userShowsList.filter(
    (s) =>
      s.status === "watching" ||
      s.status === "for_later" ||
      s.status === "completed"
  );

  const watchingIds = watching.map((s) => s.tmdbId);

  // Fast path: 2 bulk DB queries (episodes + watched). Only TMDB-fill shows missing rows.
  let allEpisodes: EpisodeInfo[] = [];
  const watchedByShow = new Map<number, Set<WatchedKey>>();
  /** Per-show watch timestamps (for bulk-mark demotion in Watch Next). */
  const watchedAtsByShow = new Map<number, Date[]>();

  if (watching.length > 0) {
    const [episodeRows, watched] = await Promise.all([
      withDbRetry(() =>
        db
          .select({
            showTmdbId: episodes.showTmdbId,
            seasonNumber: episodes.seasonNumber,
            episodeNumber: episodes.episodeNumber,
            title: episodes.title,
            airDate: episodes.airDate,
            stillPath: episodes.stillPath,
          })
          .from(episodes)
          .where(inArray(episodes.showTmdbId, watchingIds))
      ),
      withDbRetry(() =>
        db
          .select({
            showTmdbId: watchedEpisodes.showTmdbId,
            seasonNumber: watchedEpisodes.seasonNumber,
            episodeNumber: watchedEpisodes.episodeNumber,
            watchedAt: watchedEpisodes.watchedAt,
          })
          .from(watchedEpisodes)
          .where(
            and(
              eq(watchedEpisodes.userId, userId),
              inArray(watchedEpisodes.showTmdbId, watchingIds)
            )
          )
      ),
    ]);

    allEpisodes = episodeRows;

    const showsWithEpisodes = new Set(episodeRows.map((e) => e.showTmdbId));
    const missing = watching.filter((s) => !showsWithEpisodes.has(s.tmdbId));

    // Only fetch TMDB for shows with no cached episodes (not all 150 every load)
    if (missing.length > 0) {
      // Cap first paint work: fill up to 12 missing shows; rest stay empty until detail/open
      const toFill = missing.slice(0, 12);
      const filled = await mapPool(toFill, 3, (show) =>
        ensureEpisodes(show.tmdbId, show.numberOfSeasons).catch((err) => {
          console.error(
            `ensureEpisodes failed for ${show.tmdbId}:`,
            err instanceof Error ? err.message : err
          );
          return [] as EpisodeInfo[];
        })
      );
      allEpisodes = allEpisodes.concat(filled.flat());

      // Background: fill remaining missing shows without blocking the response.
      // Rejection-guarded: mapPool itself must never reject unobserved.
      const rest = missing.slice(12);
      if (rest.length > 0) {
        void mapPool(rest, 2, (show) =>
          ensureEpisodes(show.tmdbId, show.numberOfSeasons).catch(() => [])
        ).catch(() => {});
      }
    }

    for (const w of watched) {
      let set = watchedByShow.get(w.showTmdbId);
      if (!set) {
        set = new Set();
        watchedByShow.set(w.showTmdbId, set);
      }
      set.add(makeWatchedKey(w.seasonNumber, w.episodeNumber));

      if (w.watchedAt) {
        let ats = watchedAtsByShow.get(w.showTmdbId);
        if (!ats) {
          ats = [];
          watchedAtsByShow.set(w.showTmdbId, ats);
        }
        ats.push(w.watchedAt);
      }
    }
  }

  const episodesByShow = new Map<number, EpisodeInfo[]>();
  for (const ep of allEpisodes) {
    let arr = episodesByShow.get(ep.showTmdbId);
    if (!arr) {
      arr = [];
      episodesByShow.set(ep.showTmdbId, arr);
    }
    arr.push(ep);
  }

  // WATCH LIST VIEW
  const watchNext: ShowListItemData[] = [];
  const haventWatched: ShowListItemData[] = [];

  if (currentView === "watchlist") {
    /** Effective last activity (bulk-mark demoted) for sort + section split. */
    const activityByShow = new Map<number, Date | null>();

    for (const show of watching) {
      const showEpisodes = episodesByShow.get(show.tmdbId) ?? [];
      const showWatched = watchedByShow.get(show.tmdbId) ?? new Set();

      const { nextEpisode, remaining } = computeNextEpisode(
        showEpisodes,
        { seasonNumber: show.lastSeason, episodeNumber: show.lastEpisode },
        showWatched
      );

      // Caught up: every aired episode is watched → leave Watch List
      // (still followed; new eps show under Upcoming when they air)
      if (showEpisodes.length > 0 && !nextEpisode) {
        continue;
      }

      const item: ShowListItemData = {
        tmdbId: show.tmdbId,
        title: show.title,
        posterPath: show.posterPath,
        nextEpisode: nextEpisode
          ? {
              seasonNumber: nextEpisode.seasonNumber,
              episodeNumber: nextEpisode.episodeNumber,
              title: nextEpisode.title,
              stillPath: nextEpisode.stillPath,
              airDate: nextEpisode.airDate,
            }
          : null,
        remaining,
      };

      // Prefer episode timestamps (detect bulk import/"mark previous" stamps).
      // Fall back to user_shows.lastWatchedAt when no episode rows exist yet.
      const fromEpisodes = effectiveLastWatchedAt(
        watchedAtsByShow.get(show.tmdbId) ?? []
      );
      const effective =
        fromEpisodes ??
        (watchedAtsByShow.has(show.tmdbId)
          ? null // had only bulk-stamped watches → inactive
          : show.lastWatchedAt);
      activityByShow.set(show.tmdbId, effective);

      if (
        belongsInWatchNext({
          status: show.status,
          followedAt: show.followedAt,
          lastActivityAt: effective,
          hasWatches: watchedAtsByShow.has(show.tmdbId),
          caughtUpFreshDrop: isCaughtUpFreshDrop(showEpisodes, showWatched),
        })
      ) {
        watchNext.push(item);
      } else {
        haventWatched.push(item);
      }
    }

    const activityTime = (id: number) => {
      const act = activityByShow.get(id)?.getTime() ?? 0;
      if (act > 0) return act;
      const row = watching.find((s) => s.tmdbId === id);
      return (
        row?.followedAt?.getTime() ??
        row?.updatedAt?.getTime() ??
        row?.lastWatchedAt?.getTime() ??
        0
      );
    };
    const nextAirTime = (airDate?: string | null) => {
      const ymd = airDate ? toYmd(airDate) : null;
      if (!ymd) return 0;
      const t = Date.parse(`${ymd}T12:00:00Z`);
      return Number.isFinite(t) ? t : 0;
    };

    watchNext.sort((a, b) => {
      const aScore = Math.max(
        activityTime(a.tmdbId),
        nextAirTime(a.nextEpisode?.airDate)
      );
      const bScore = Math.max(
        activityTime(b.tmdbId),
        nextAirTime(b.nextEpisode?.airDate)
      );
      return bScore - aScore;
    });
    // Dormant: oldest activity first (longest neglected at top), nulls last
    haventWatched.sort((a, b) => {
      const ta = activityByShow.get(a.tmdbId)?.getTime();
      const tb = activityByShow.get(b.tmdbId)?.getTime();
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    });
  }

  // UPCOMING VIEW
  type UpcomingItem = {
    tmdbId: number;
    title: string;
    posterPath: string | null;
    seasonNumber: number;
    episodeNumber: number;
    episodeTitle: string;
    stillPath: string | null;
    airDate: string;
    isPremiere: boolean;
    isLatest: boolean;
    aired: boolean;
  };

  let upcomingItems: UpcomingItem[] = [];

  if (currentView === "upcoming") {
    for (const show of watching) {
      const showEpisodes = episodesByShow.get(show.tmdbId) ?? [];
      const showWatched = watchedByShow.get(show.tmdbId) ?? new Set();

      const upcoming = computeUpcomingEpisodes(showEpisodes, showWatched);

      // LATEST = most recent already-aired unwatched ep for this show in the list
      let latestKey: string | null = null;
      let latestTime = -Infinity;
      for (const ep of upcoming) {
        if (!ep.airDate || !isEpisodeAired(ep.airDate)) continue;
        const ymd = toYmd(ep.airDate) ?? "";
        const t = ymd ? Date.parse(ymd + "T12:00:00Z") : -Infinity;
        if (
          t > latestTime ||
          (t === latestTime &&
            latestKey !== null &&
            (ep.seasonNumber * 1000 + ep.episodeNumber >
              Number(latestKey.split(":")[0]) * 1000 +
                Number(latestKey.split(":")[1])))
        ) {
          latestTime = t;
          latestKey = `${ep.seasonNumber}:${ep.episodeNumber}`;
        }
      }

      for (const ep of upcoming) {
        if (!ep.airDate) continue;
        const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
        upcomingItems.push({
          tmdbId: show.tmdbId,
          title: show.title,
          posterPath: show.posterPath,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          episodeTitle: ep.title,
          stillPath: ep.stillPath ?? null,
          airDate: ep.airDate,
          isPremiere: ep.episodeNumber === 1,
          isLatest: latestKey === key,
          aired: isEpisodeAired(ep.airDate),
        });
      }
    }

    upcomingItems.sort((a, b) => {
      const ya = toYmd(a.airDate) ?? "";
      const yb = toYmd(b.airDate) ?? "";
      return ya < yb ? -1 : ya > yb ? 1 : 0;
    });
    // Cap size but keep enough past+future for scroll-to-today
    upcomingItems = upcomingItems.slice(0, 120);
  }

  const upcomingGroupMap = new Map<string, UpcomingItem[]>();
  for (const item of upcomingItems) {
    const key = dateKey(item.airDate);
    let group = upcomingGroupMap.get(key);
    if (!group) {
      group = [];
      upcomingGroupMap.set(key, group);
    }
    group.push(item);
  }
  const upcomingGroups: UpcomingGroup[] = Array.from(upcomingGroupMap.keys())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => {
      const items = upcomingGroupMap.get(key)!;
      return {
        dateKey: key,
        label: formatAppCalendarDate(items[0].airDate),
        items: items.map((item) => ({
          ...item,
          daysUntil: daysUntilYmd(item.airDate) ?? 0,
        })),
      };
    });

  return (
    <div className="min-h-dvh bg-background px-4 pb-nav-page">
      <StickyChrome contentClassName="pt-2">
        <div className="relative">
          <ShowTabs
            tabs={[
              { value: "watchlist", label: "WATCH LIST" },
              { value: "upcoming", label: "UPCOMING" },
            ]}
          />
          <Link
            href="/calendar"
            aria-label="Calendar"
            className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground"
          >
            <CalendarDays className="h-5 w-5" />
          </Link>
        </div>
      </StickyChrome>

      {currentView === "watchlist" && (
        <>
          {watching.length > 0 && watching.length < 3 && <OnboardingNudge />}
          {watchNext.length > 0 && (
            <section className="mb-6">
              <div className="relative mb-3 mt-2 flex justify-center">
                <SectionLabel>Watch Next</SectionLabel>
                <div className="absolute right-0 top-1/2 -translate-y-1/2">
                  <LayoutToggle scope="shows" initialLayout={layoutPref} />
                </div>
              </div>
              {gridLayout ? (
                <div className="grid grid-cols-3 gap-2">
                  {watchNext.map((show) => (
                    <ShowCard key={show.tmdbId} show={show} />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {watchNext.map((show) => (
                    <ShowListItem key={show.tmdbId} show={show} />
                  ))}
                </div>
              )}
            </section>
          )}

          {haventWatched.length > 0 && (
            <section className="mb-6">
              <div
                className={`relative mb-3 flex justify-center ${
                  watchNext.length === 0 ? "mt-2" : ""
                }`}
              >
                <SectionLabel>Haven&apos;t watched for a while</SectionLabel>
                {watchNext.length === 0 && (
                  <div className="absolute right-0 top-1/2 -translate-y-1/2">
                    <LayoutToggle scope="shows" initialLayout={layoutPref} />
                  </div>
                )}
              </div>
              {gridLayout ? (
                <div className="grid grid-cols-3 gap-2">
                  {haventWatched.map((show) => (
                    <ShowCard key={show.tmdbId} show={show} />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {haventWatched.map((show) => (
                    <ShowListItem key={show.tmdbId} show={show} />
                  ))}
                </div>
              )}
            </section>
          )}

          {watching.length === 0 && (
            <div className="flex flex-col items-center justify-center pt-20">
              <p className="mb-4 text-muted-foreground">
                No shows in your watch list yet
              </p>
              <Link
                href="/explore"
                className="rounded-full bg-primary px-6 py-3 text-sm font-bold text-black"
              >
                BROWSE ALL SHOWS
              </Link>
              <Link
                href="/import"
                className="mt-2.5 rounded-full px-6 py-2.5 text-sm font-bold text-muted-foreground ring-1 ring-border transition hover:bg-secondary hover:text-foreground"
              >
                Import your data
              </Link>
            </div>
          )}
        </>
      )}

      {currentView === "upcoming" && (
        <>
          {upcomingGroups.length > 0 ? (
            <UpcomingList groups={upcomingGroups} />
          ) : (
            <div className="flex flex-col items-center justify-center pt-20">
              <p className="mb-4 text-muted-foreground">
                No upcoming episodes for your shows
              </p>
              <Link
                href="/explore"
                className="rounded-full bg-primary px-6 py-3 text-sm font-bold text-black"
              >
                BROWSE ALL SHOWS
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
