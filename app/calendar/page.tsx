import { requireAuth } from "@/lib/auth";
import {
  loadFollowedEpisodeData,
  loadUnreleasedMovies,
} from "@/lib/calendar-data";
import { isEpisodeAired } from "@/lib/show-progress";
import { appTodayYmd, daysUntilYmd, toYmd, ymdAddDays } from "@/lib/app-time";
import {
  CalendarMonth,
  type CalendarDay,
  type CalendarEpisode,
  type CalendarMovie,
} from "@/components/calendar-month";
import Link from "next/link";
import { ChevronLeft, CalendarDays } from "lucide-react";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Calendar — LeviOsa",
  description: "Every premiere and finale on each day for shows you follow.",
};

export const dynamic = "force-dynamic";

function monthKey(ymd: string): string {
  return ymd.slice(0, 7); // YYYY-MM
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 12))
    .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

/**
 * Month-grid calendar — everything that aired/airs on each day for shows you
 * follow (watched included). Upcoming is the to-do list; this is the agenda.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; back?: string }>;
}) {
  const { month, back } = await searchParams;
  const userId = await requireAuth();
  // Back target allowlist: internal tab paths only (default Shows).
  const backHref =
    back && /^(\/(shows|movies|explore|profile|library)(\/|$))/.test(back)
      ? back
      : "/shows";

  const today = appTodayYmd();
  const currentKey = monthKey(today);
  const key = month && /^\d{4}-\d{2}$/.test(month) ? month : currentKey;

  const [y, m] = key.split("-").map(Number);
  const monthStart = `${key}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${key}-${String(lastDay).padStart(2, "0")}`;

  const [{ following, episodesByShow, watchedByShow }, unreleasedMovies] =
    await Promise.all([
      loadFollowedEpisodeData(userId),
      loadUnreleasedMovies(userId),
    ]);

  // Episodes landing inside this month (watched history included)
  const byDay = new Map<string, CalendarEpisode[]>();
  for (const show of following) {
    const showWatched = watchedByShow.get(show.tmdbId) ?? new Set();
    for (const ep of episodesByShow.get(show.tmdbId) ?? []) {
      const ymd = toYmd(ep.airDate);
      if (!ymd || ymd < monthStart || ymd > monthEnd) continue;
      const item: CalendarEpisode = {
        tmdbId: show.tmdbId,
        showTitle: show.title,
        posterPath: show.posterPath,
        stillPath: ep.stillPath ?? null,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        episodeTitle: ep.title,
        airDate: ymd,
        aired: isEpisodeAired(ymd),
        watched: showWatched.has(`${ep.seasonNumber}:${ep.episodeNumber}`),
        isPremiere: ep.episodeNumber === 1,
        daysUntil: daysUntilYmd(ymd) ?? 0,
      };
      const arr = byDay.get(ymd);
      if (arr) arr.push(item);
      else byDay.set(ymd, [item]);
    }
  }

  // 6-row grid starting on the Sunday of the week containing the 1st
  const firstDow = new Date(Date.UTC(y, m - 1, 1, 12)).getUTCDay(); // 0 = Sun
  const gridStart = ymdAddDays(monthStart, -firstDow);
  // Movie releases landing in the visible grid (watchlist only).
  const moviesByDay = new Map<string, CalendarMovie[]>();
  for (const mv of unreleasedMovies) {
    if (mv.releaseDate < gridStart || mv.releaseDate > ymdAddDays(gridStart, 41)) continue;
    const arr = moviesByDay.get(mv.releaseDate);
    if (arr) arr.push(mv);
    else moviesByDay.set(mv.releaseDate, [mv]);
  }
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const date = ymdAddDays(gridStart, i);
    days.push({
      date,
      day: Number(date.slice(8, 10)),
      inMonth: date >= monthStart && date <= monthEnd,
      episodes: (byDay.get(date) ?? []).sort((a, b) =>
        a.showTitle.localeCompare(b.showTitle)
      ),
      movies: (moviesByDay.get(date) ?? []).sort((a, b) =>
        a.title.localeCompare(b.title)
      ),
    });
  }

  return (
    <div className="min-h-dvh bg-background px-4 pb-nav-page">
      <div className="sticky-chrome-crisp sticky top-0 z-40 -mx-4 bg-background/85 px-4 pb-2 pt-safe-float backdrop-blur">
        <div className="flex items-center justify-between">
          <Link
            href={backHref}
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <h1 className="flex items-center gap-2 text-base font-black uppercase tracking-wide text-foreground">
            <CalendarDays className="h-4 w-4 text-primary" />
            Calendar
          </h1>
          <div className="h-9 w-9" />
        </div>
      </div>

      <div className="mt-4">
        <CalendarMonth
          monthLabel={monthLabel(key)}
          days={days}
          today={today}
          prevHref={`/calendar?month=${shiftMonth(key, -1)}&back=${encodeURIComponent(backHref)}`}
          nextHref={`/calendar?month=${shiftMonth(key, 1)}&back=${encodeURIComponent(backHref)}`}
        />
      </div>
    </div>
  );
}
