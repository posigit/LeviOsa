"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { backdropUrl, posterUrl, stillUrl } from "@/lib/tmdb";
import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";
import type { MovieTheme } from "@/lib/movie-theme";
import type { MotnWatch } from "@/lib/motn";
import { isEpisodeAired } from "@/lib/show-progress";
import { daysUntilYmd, formatAppDateShort } from "@/lib/app-time";
import { Confetti } from "@/components/confetti";
import { EpisodeRating, StarRatingDisplay } from "@/components/star-rating";
import { DiscoverRail } from "@/components/discover-rail";
import { WhereToWatch } from "@/components/where-to-watch";
import { CommunityReviews } from "@/components/community-reviews";
import { ScoreStrip } from "@/components/score-strip";
import { DownloadButton } from "@/components/download-button";
import { VixPlayer } from "@/components/vix-player";
import { UpNextCard } from "@/components/up-next-card";
import { EndOfLineCard } from "@/components/end-of-line-card";
import { NextEpisodeFab } from "@/components/next-episode-fab";
import { FavoriteButton } from "@/components/favorite-button";
import { AddToListButton } from "@/components/add-to-list-button";
import { vixTvUrl } from "@/lib/vixsrc";
import { loadVixSettings } from "@/lib/vix-settings";
import { TmdbIcon } from "@/components/rt-icons";
import { formatEpisodeLabel, useToast } from "@/components/toast";
import type {
  TmdbMediaCard,
  TmdbVideo,
  WatchProvidersResult,
} from "@/lib/tmdb";
import type { ReviewsPayload } from "@/lib/reviews";
import type { PlaybackSummary } from "@/lib/playback";
import { formatPlaybackTime } from "@/lib/playback-format";
import { postJsonOffline, queuedOffline } from "@/lib/offline/send";
import {
  BookmarkCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Play,
  Plus,
} from "lucide-react";

export type DetailEpisode = {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview?: string;
  airDate?: string;
  stillPath?: string | null;
  runtime?: number;
  watched: boolean;
};

export type ShowCastMember = {
  id: number;
  name: string;
  character: string | null;
  profilePath: string | null;
};

export type DetailShow = {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  status: string | null;
  networks: string[] | null;
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  episodeRuntime: number | null;
  voteAverage: number | null;
  rtScore: number | null;
  firstAirDate: string | null;
  genres: string[];
};

function watchKey(seasonNumber: number, episodeNumber: number) {
  return `${seasonNumber}:${episodeNumber}`;
}

function compareEp(a: DetailEpisode, b: DetailEpisode) {
  return a.seasonNumber !== b.seasonNumber
    ? a.seasonNumber - b.seasonNumber
    : a.episodeNumber - b.episodeNumber;
}

function formatDate(airDate?: string) {
  return formatAppDateShort(airDate);
}

function seasonLabel(seasonNumber: number) {
  return seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
}

function daysUntil(airDate?: string): number | null {
  return daysUntilYmd(airDate);
}

/** "S3, E1" — the reference CTA's episode label. */
function episodeCode(ep: { seasonNumber: number; episodeNumber: number }) {
  return `S${ep.seasonNumber}, E${ep.episodeNumber}`;
}

export function ShowDetailClient({
  show,
  creators = [],
  cast = [],
  stickers = [],
  clearartSrc = null,
  watch = null,
  videos = [],
  episodes,
  rewatchCounts: initialRewatchCounts,
  initialFollowing,
  initialFavorite = false,
  episodeRatings,
  derivedScore,
  moreLikeThis = [],
  recommended = [],
  providers = null,
  reviews,
  trailerKey = null,
  playbackPositions = {},
  logoSrc = null,
  theme,
}: {
  show: DetailShow;
  creators?: string[];
  cast?: ShowCastMember[];
  stickers?: string[];
  clearartSrc?: string | null;
  watch?: MotnWatch | null;
  videos?: TmdbVideo[];
  episodes: DetailEpisode[];
  rewatchCounts: Record<number, number>;
  initialFollowing: boolean;
  initialFavorite?: boolean;
  episodeRatings: Record<string, number>;
  derivedScore: { value: number; count: number } | null;
  moreLikeThis?: TmdbMediaCard[];
  recommended?: TmdbMediaCard[];
  providers?: WatchProvidersResult | null;
  reviews?: ReviewsPayload;
  trailerKey?: string | null;
  playbackPositions?: Record<string, PlaybackSummary>;
  logoSrc?: string | null;
  theme: MovieTheme;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [watchedMap, setWatchedMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const ep of episodes) {
      map[watchKey(ep.seasonNumber, ep.episodeNumber)] = ep.watched;
    }
    return map;
  });
  const watchedMapRef = useRef(watchedMap);
  const [rewatchCounts, setRewatchCounts] = useState(initialRewatchCounts);
  const [confetti, setConfetti] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [following, setFollowing] = useState(initialFollowing);

  const [rewatchSeason, setRewatchSeason] = useState<number | "all" | null>(
    null
  );
  const [markPreviousTarget, setMarkPreviousTarget] =
    useState<DetailEpisode | null>(null);
  /** Confirm sheet for the whole-series check beside "Episodes". */
  const [confirmAllWatched, setConfirmAllWatched] = useState(false);
  const [pending, setPending] = useState(false);
  /** Episode currently open in the VixSrc player overlay. */
  const [playerEp, setPlayerEp] = useState<DetailEpisode | null>(null);
  const playerSessionRef = useRef(0);
  /** Next episode queued after the current one ends (autoplay countdown). */
  const [upNext, setUpNext] = useState<DetailEpisode | null>(null);
  const [upNextCount, setUpNextCount] = useState(0);
  /**
   * Stashed next ep after the user cancels Up Next. The glass Next FAB only
   * appears once playback hits ~96% (see nearEnd) — cancel alone does not
   * show it early.
   */
  const [manualNext, setManualNext] = useState<DetailEpisode | null>(null);
  /** True once VixPlayer reports progress ≥ NEXT_FAB_RATIO (0.96). */
  const [nearEnd, setNearEnd] = useState(false);
  /** True when the played episode ended and there's no next aired episode. */
  const [seriesEnded, setSeriesEnded] = useState(false);

  const isWatched = (ep: DetailEpisode) =>
    watchedMap[watchKey(ep.seasonNumber, ep.episodeNumber)] ?? false;

  const playbackFor = (ep: DetailEpisode) =>
    playbackPositions[watchKey(ep.seasonNumber, ep.episodeNumber)] ?? null;

  const resumeLabel = (ep: DetailEpisode) => {
    const playback = playbackFor(ep);
    if (!playback) return null;
    const timeLeft = formatPlaybackTime(playback.timeLeftSeconds);
    return timeLeft ? `Resume · ${timeLeft} left` : "Resume";
  };

  // ---------- derived data ----------

  const seasons = useMemo(() => {
    const bySeason = new Map<number, DetailEpisode[]>();
    for (const ep of episodes) {
      const arr = bySeason.get(ep.seasonNumber) ?? [];
      arr.push(ep);
      bySeason.set(ep.seasonNumber, arr);
    }
    return Array.from(bySeason.entries())
      .map(([seasonNumber, eps]) => {
        eps.sort(compareEp);
        const watchedCount = eps.filter((e) => isWatched(e)).length;
        return {
          seasonNumber,
          episodes: eps,
          total: eps.length,
          watchedCount,
          complete: eps.length > 0 && watchedCount === eps.length,
        };
      })
      .sort((a, b) => {
        if (a.seasonNumber === 0) return 1; // Specials last
        if (b.seasonNumber === 0) return -1;
        return a.seasonNumber - b.seasonNumber;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, watchedMap]);

  const allWatched =
    episodes.length > 0 && episodes.every((ep) => isWatched(ep));

  /** True when the show has no future episodes coming (ended, or catalog fully aired). */
  const fullyAired =
    show.status === "Ended" ||
    show.status === "Canceled" ||
    (episodes.length > 0 && episodes.every((ep) => isEpisodeAired(ep.airDate)));

  /** "Finished" only when everything is watched AND nothing more is coming. */
  const isFinished = allWatched && fullyAired;

  const nextEpisode = useMemo(() => {
    const sorted = [...episodes].sort(compareEp);
    return (
      sorted.find((ep) => !isWatched(ep) && isEpisodeAired(ep.airDate)) ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, watchedMap]);

  /** First unwatched UNAIRED episode — shown as countdown when caught up. */
  const nextUnaired = useMemo(() => {
    const sorted = [...episodes].sort(compareEp);
    return (
      sorted.find((ep) => !isWatched(ep) && !isEpisodeAired(ep.airDate)) ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, watchedMap]);

  /** Seasons start collapsed — the season you want is one tap away. */
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(
    () => new Set<number>()
  );

  /** Hero progress — episodes seen / episodes that exist. */
  const watchedCount = useMemo(
    () => episodes.filter((ep) => isWatched(ep)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [episodes, watchedMap]
  );
  const totalCount = episodes.length;

  /**
   * Hero bar reads as an episode count — "20 of 26" — because a series is
   * consumed episode by episode. Hidden until it has actually been started:
   * a fresh show shows no bar, a finished one reads "26 of 26" at 100%.
   */
  const { progressStarted, progressPct } = useMemo(() => {
    const touched =
      watchedCount > 0 || episodes.some((ep) => playbackFor(ep) != null);
    return {
      progressStarted: touched && totalCount > 0,
      progressPct:
        totalCount > 0
          ? Math.min(100, (watchedCount / totalCount) * 100)
          : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, watchedMap, playbackPositions]);

  /**
   * Primary CTA. The player marks an episode seen on `ended`, so the hero's
   * job is starting playback — "mark seen" lives on the episode rows.
   *  1. next unwatched aired episode  → Watch S3, E1
   *  2. caught up, one still coming   → dimmed countdown (not tappable)
   *  3. series finished               → Rewatch S1, E1
   */
  const rewatchStart = useMemo(() => {
    if (nextEpisode || nextUnaired || episodes.length === 0) return null;
    return [...episodes].sort(compareEp).find((ep) => isEpisodeAired(ep.airDate)) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, watchedMap]);

  const nextKey = nextEpisode
    ? watchKey(nextEpisode.seasonNumber, nextEpisode.episodeNumber)
    : null;

  /** Started-but-unfinished next episode — the pill says "Resume S1, E2". */
  const nextEpisodeStarted = nextEpisode
    ? playbackFor(nextEpisode) != null
    : false;

  const nextCtaLabel = nextEpisode
    ? `${nextEpisodeStarted ? "Resume" : "Watch"} ${episodeCode(nextEpisode)}`
    : null;

  /** The series' first aired episode — its banner reads "Pilot", not "Up next". */
  const isPilotNext = useMemo(() => {
    if (!nextEpisode) return false;
    const first = [...episodes]
      .sort(compareEp)
      .find((ep) => isEpisodeAired(ep.airDate));
    return (
      first != null &&
      first.seasonNumber === nextEpisode.seasonNumber &&
      first.episodeNumber === nextEpisode.episodeNumber
    );
  }, [episodes, nextEpisode]);

  // ---------- actions ----------

  const postWatch = async (
    items: {
      showTmdbId: number;
      seasonNumber: number;
      episodeNumber: number;
      watched: boolean;
    }[]
  ): Promise<boolean> => {
    const res = await postJsonOffline(
      "/api/watch",
      items.length === 1 ? items[0] : { episodes: items }
    );
    if (!res.ok) throw new Error("watch request failed");
    return queuedOffline(res);
  };

  /** Fire confetti only when this update truly finishes the series (fully aired + all watched). */
  const celebrateIfComplete = (map: Record<string, boolean>) => {
    if (!fullyAired) return;
    const done =
      episodes.length > 0 &&
      episodes.every(
        (ep) => map[watchKey(ep.seasonNumber, ep.episodeNumber)] ?? false
      );
    if (done) setConfetti(true);
  };

  const applyWatched = async (
    items: { seasonNumber: number; episodeNumber: number; watched: boolean }[]
  ): Promise<boolean> => {
    if (items.length === 0) return false;

    const prev = watchedMapRef.current;
    const next = { ...prev };
    for (const item of items) {
      next[watchKey(item.seasonNumber, item.episodeNumber)] = item.watched;
    }
    watchedMapRef.current = next;
    setWatchedMap(next);
    if (items.some((i) => i.watched)) {
      celebrateIfComplete(next);
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
    }

    try {
      const offline = await postWatch(
        items.map((i) => ({
          showTmdbId: show.tmdbId,
          seasonNumber: i.seasonNumber,
          episodeNumber: i.episodeNumber,
          watched: i.watched,
        }))
      );
      const suffix = offline ? " — saved offline" : "";

      const marking = items.filter((i) => i.watched);
      const unmarking = items.filter((i) => !i.watched);
      if (marking.length === 1 && unmarking.length === 0) {
        toast(
          `Watched ${formatEpisodeLabel(marking[0].seasonNumber, marking[0].episodeNumber)}${suffix}`
        );
      } else if (marking.length > 1 && unmarking.length === 0) {
        toast(`Marked ${marking.length} episodes watched${suffix}`);
      } else if (unmarking.length > 0 && marking.length === 0) {
        toast(
          (unmarking.length === 1
            ? "Unmarked episode"
            : `Unmarked ${unmarking.length} episodes`) + suffix
        );
      }
    } catch {
      watchedMapRef.current = prev;
      setWatchedMap(prev);
      toast("Couldn't save — try again", "error");
      return false;
    }

    return true;
  };

  const previousUnwatchedAired = (episode: DetailEpisode) =>
    episodes.filter(
      (ep) =>
        compareEp(ep, episode) < 0 && !isWatched(ep) && isEpisodeAired(ep.airDate)
    );

  const handleEpisodeToggle = (episode: DetailEpisode, watched: boolean) => {
    if (watched && !isEpisodeAired(episode.airDate)) return;
    if (watched && previousUnwatchedAired(episode).length > 0) {
      setMarkPreviousTarget(episode);
      return;
    }
    void applyWatched([
      {
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        watched,
      },
    ]);
  };

  const handleMarkPrevious = async (includePrevious: boolean) => {
    const target = markPreviousTarget;
    setMarkPreviousTarget(null);
    if (!target) return;

    const items = includePrevious
      ? episodes
          .filter(
            (ep) =>
              compareEp(ep, target) <= 0 &&
              !isWatched(ep) &&
              isEpisodeAired(ep.airDate)
          )
          .map((ep) => ({
            seasonNumber: ep.seasonNumber,
            episodeNumber: ep.episodeNumber,
            watched: true,
          }))
      : [
          {
            seasonNumber: target.seasonNumber,
            episodeNumber: target.episodeNumber,
            watched: true,
          },
        ];
    await applyWatched(items);
  };

  const handleSeasonBadge = (season: {
    seasonNumber: number;
    episodes: DetailEpisode[];
    complete: boolean;
  }) => {
    if (season.complete) {
      setRewatchSeason(season.seasonNumber);
      return;
    }
    // Mark every aired episode of this season watched
    const items = season.episodes
      .filter((ep) => !isWatched(ep) && isEpisodeAired(ep.airDate))
      .map((ep) => ({
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        watched: true,
      }));
    if (items.length > 0) void applyWatched(items);
  };

  const runAllEpisodesToggle = () => {
    if (allWatched) {
      void applyWatched(
        episodes.map((ep) => ({
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          watched: false,
        }))
      );
    } else {
      void applyWatched(
        episodes
          .filter((ep) => !isWatched(ep) && isEpisodeAired(ep.airDate))
          .map((ep) => ({
            seasonNumber: ep.seasonNumber,
            episodeNumber: ep.episodeNumber,
            watched: true,
          }))
      );
    }
  };

  /** Whole-series marks are one tap away but never one accident away. */
  const handleAllEpisodesToggle = () => setConfirmAllWatched(true);

  const openPlayer = (ep: DetailEpisode) => {
    if (!isEpisodeAired(ep.airDate)) return;
    playerSessionRef.current += 1;
    setPlayerEp(ep);
    setSeriesEnded(false);
    setManualNext(null);
    setNearEnd(false);
    setUpNext(null);
    setUpNextCount(0);
  };

  /**
   * Streaming events from VixSrc. On "ended": mark the episode watched,
   * then auto-advance to the next unwatched aired episode (seamless binge).
   */
  const handlePlayerEvent = async (event: string) => {
    if (event !== "ended" || !playerEp) return;
    const session = playerSessionRef.current;
    const endedEpisode = playerEp;
    const alreadyWatched = isWatched(endedEpisode);

    if (!alreadyWatched) {
      const saved = await applyWatched([
        {
          seasonNumber: endedEpisode.seasonNumber,
          episodeNumber: endedEpisode.episodeNumber,
          watched: true,
        },
      ]);
      if (!saved) return;
      // Closing or replacing the player while the watch request was pending
      // cancels auto-advance instead of reopening the next episode.
      if (playerSessionRef.current !== session) return;
    }

    const next = [...episodes]
      .sort(compareEp)
      .find(
        (ep) =>
          compareEp(ep, endedEpisode) > 0 &&
          !watchedMapRef.current[watchKey(ep.seasonNumber, ep.episodeNumber)] &&
          isEpisodeAired(ep.airDate)
      );

    // Always surface Up Next when a later aired unwatched ep exists (season
    // finales → S+1E1 count). autoplayNext only controls the 10…0 auto-advance;
    // when off, the card still shows and the user taps to play (or X → FAB).
    if (next) {
      setManualNext(null);
      setUpNext(next);
      setUpNextCount(loadVixSettings().autoplayNext ? 10 : 0);
      return;
    }

    // No next aired episode (series finale, or waiting for next week): keep the
    // player OPEN so the final scene plays to the true end, and surface an
    // "end of the line" card instead of slamming the player shut at 92%.
    // Handles both first-run and rewatched episodes (an episode auto-completed
    // at 92% on a prior attempt is already watched — it must still show the
    // card instead of closing silently).
    setUpNext(null);
    setUpNextCount(0);
    setManualNext(null);
    setSeriesEnded(true);
  };

  /** Play the queued "up next" (or post-cancel manual) episode immediately. */
  const playUpNext = useCallback(() => {
    const next = upNext ?? manualNext;
    if (!next) return;
    playerSessionRef.current += 1;
    setPlayerEp(next);
    setUpNext(null);
    setUpNextCount(0);
    setManualNext(null);
    setNearEnd(false);
    setSeriesEnded(false);
  }, [upNext, manualNext]);

  /**
   * Cancel autoplay countdown only. Stash the next ep for the glass FAB;
   * do not show the FAB until nearEnd (≥96%) — unless already past that.
   */
  const cancelUpNext = useCallback(() => {
    if (upNext) setManualNext(upNext);
    setUpNext(null);
    setUpNextCount(0);
  }, [upNext]);

  // Count down the "up next" overlay; when it hits 0, auto-play the next ep.
  // upNextCount === 0 means autoplay is off — card stays, no timer.
  // Auto-fire happens in the timeout callback (event context), never in the
  // render phase. Bail if the player was closed mid-countdown (playerEp gone) —
  // never reopen an episode the user dismissed.
  useEffect(() => {
    if (!upNext || !playerEp || upNextCount <= 0) return;
    const t = window.setTimeout(() => {
      if (upNextCount <= 1) {
        playUpNext();
      } else {
        setUpNextCount(upNextCount - 1);
      }
    }, 1000);
    return () => window.clearTimeout(t);
  }, [upNext, upNextCount, playerEp, playUpNext]);

  const confirmRewatch = async () => {
    if (rewatchSeason === null) return;
    const target = rewatchSeason; // number (season) | "all" (whole series)
    setPending(true);
    try {
      const res = await fetch("/api/rewatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showTmdbId: show.tmdbId,
          ...(target === "all"
            ? { season: "all" }
            : { seasonNumber: target }),
        }),
      });
      if (!res.ok) throw new Error("rewatch failed");
      const data = await res.json();

      // Non-destructive: server cleared resume bookmarks only. Local watched
      // state (and ratings/history) intentionally untouched — bump the badge
      // locally and let router.refresh() sync resume labels from the DB.
      if (target === "all") {
        setRewatchCounts((prev) => ({
          ...prev,
          [0]: data.count ?? (prev[0] ?? 0) + 1,
        }));
        setExpandedSeasons((prev) => {
          const first = seasons[0]?.seasonNumber;
          return first != null ? new Set(prev).add(first) : prev;
        });
        toast("Series rewatch started");
      } else {
        setRewatchCounts((prev) => ({
          ...prev,
          [target]: data.count ?? (prev[target] ?? 0) + 1,
        }));
        setExpandedSeasons((prev) => new Set(prev).add(target));
        toast(`Season ${target} rewatch started`);
      }
      router.refresh();
    } catch {
      toast("Couldn't start rewatch — try again", "error");
    } finally {
      setPending(false);
      setRewatchSeason(null);
    }
  };

  const toggleFollow = async () => {
    const next = !following;
    setFollowing(next);
    setMenuOpen(false);
    try {
      await fetch("/api/show-follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: show.tmdbId, following: next }),
      });
    } catch {
      setFollowing(!next);
    }
  };

  /** Show the favorite affordance only once something's been watched. */
  const hasWatchedEpisodes = episodes.some((ep) => isWatched(ep));

  const toggleSeason = (seasonNumber: number) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(seasonNumber)) next.delete(seasonNumber);
      else next.add(seasonNumber);
      return next;
    });
  };

  // ---------- header meta ----------

  /** Rating badge: raw Tomatometer (96%) when RT exists, else TMDB X.X/10.
   *  `rt_score = -1` means "checked, no RT" — fall through to TMDB. */
  const rating =
    show.rtScore != null && show.rtScore >= 0
      ? { icon: "rt" as const, text: `${show.rtScore}%` }
      : show.voteAverage
        ? { icon: "tmdb" as const, text: `${show.voteAverage.toFixed(1)}/10` }
        : null;

  /** "Drama · Comedy · Hulu" — genres first, then the flagship network. */
  const metaLine = [
    ...show.genres.slice(0, 3),
    ...(show.networks && show.networks.length > 0 ? [show.networks[0]] : []),
  ];

  /** Full-bleed key art. Poster crops best in a portrait frame; backdrop is fallback. */
  const heroSrc = show.posterPath
    ? posterUrl(show.posterPath, "original")
    : show.backdropPath
      ? backdropUrl(show.backdropPath, "original")
      : null;

  const stickerArt = clearartSrc
    ? [...stickers, ...(stickers.includes(clearartSrc) ? [] : [clearartSrc])]
    : stickers;

  /** Trailers section data — YouTube thumb, or nothing when there's no trailer. */
  const trailerName =
    videos.find((v) => v.key === trailerKey)?.name ?? "Official trailer";
  const trailerPoster = trailerKey
    ? `https://i.ytimg.com/vi/${trailerKey}/hqdefault.jpg`
    : null;
  const extraTrailers = videos
    .filter((v) => v.site === "YouTube" && v.key && v.key !== trailerKey)
    .slice(0, 5);

  return (
    <div
      className="min-h-dvh bg-black pb-safe-page"
      style={
        {
          "--theme": theme.v,
          "--theme-deep": theme.deep,
        } as CSSProperties
      }
    >
      <Confetti fire={confetti} />

      {/* ---------- Floating controls — stick over the scroll, like the app ---------- */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-40 px-4 top-safe-float">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.back()}
            aria-label="Back"
              className="glass-control bg-white/10 pointer-events-auto grid h-10 w-10 place-items-center rounded-full text-white transition hover:bg-white/25 active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>

          <div className="relative flex items-center gap-2">
            <AddToListButton
              mediaType="show"
              tmdbId={show.tmdbId}
              title={show.title}
              posterPath={show.posterPath}
            />
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="More"
              aria-expanded={menuOpen}
            className="glass-control bg-white/10 pointer-events-auto grid h-10 w-10 place-items-center rounded-full text-white transition hover:bg-white/25 active:scale-95"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>

            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 -z-10"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden
                />
                <div className="absolute right-0 top-12 w-48 overflow-hidden rounded-2xl border border-white/10 bg-card shadow-2xl">
                  <button
                    onClick={toggleFollow}
                    className="w-full px-4 py-3 text-left text-sm font-medium text-white hover:bg-secondary"
                  >
                    {following ? "Remove from watch list" : "Add to watch list"}
                  </button>
                  <button
                    onClick={() => {
                      setRewatchSeason("all");
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-white hover:bg-secondary"
                  >
                    <span>Rewatch series</span>
                    {rewatchCounts[0] > 0 && (
                      <span className="text-xs font-bold text-success">
                        ×{rewatchCounts[0] + 1}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      const complete = seasons.filter((s) => s.complete);
                      const target =
                        complete.at(-1)?.seasonNumber ?? seasons[0]?.seasonNumber;
                      if (target != null) {
                        setRewatchSeason(target);
                        setMenuOpen(false);
                      }
                    }}
                    className="w-full px-4 py-3 text-left text-sm font-medium text-white hover:bg-secondary"
                  >
                    Rewatch season
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ---------- Full-bleed hero ---------- */}
      <div className="relative isolate h-[72dvh] max-h-[720px] min-h-[460px] overflow-hidden">
        {heroSrc ? (
          <Image
            src={heroSrc}
            alt={`${show.title} key art`}
            fill
            sizes="100vw"
            className="object-cover object-top"
            priority
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, rgb(var(--theme) / 0.55), #000)",
            }}
          />
        )}

        {/* Theme seam: tints the art, sits UNDER both scrims so the page edge
            below the hero always crushes to true black — painting it on top
            washes a solid theme-colour band across the progress row. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 60% at 50% 100%, rgb(var(--theme) / 0.32), transparent 70%)",
          }}
        />

        {/* Legibility scrims: status bar readable up top, title readable at the base. */}
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

        {/* Hero footer: status → title → meta → progress */}
        {/* Bottom padding only matches the bar's footprint when the bar is
            there — a fresh series shouldn't carry an empty gap. */}
        <div
          className={`absolute inset-x-0 bottom-0 px-5 text-center ${
            progressStarted ? "pb-6" : "pb-2"
          }`}
        >
          {show.status && (
            <span className="glass-control inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/90">
              {show.status}
            </span>
          )}

          <h1 className="mt-3 flex justify-center px-4">
            {logoSrc ? (
                  <Image
                    src={logoSrc}
                    alt={show.title}
                    width={512}
                    height={288}
                sizes="(max-width: 480px) 88vw, 460px"
                className="h-16 w-auto max-w-full object-contain drop-shadow-[0_6px_22px_rgba(0,0,0,0.95)] sm:h-20"
              />
            ) : (
              <span className="text-4xl font-black tracking-tight text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.9)]">
                {show.title}
              </span>
            )}
          </h1>

          {metaLine.length > 0 ? (
            <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-[15px] text-white/75">
              {metaLine.map((item, i) => (
                <span key={item} className="inline-flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden className="text-white/35">
                      ·
                    </span>
                  )}
                  {item}
                </span>
              ))}
            </p>
          ) : (
            <p className="mt-3 text-center text-[15px] text-white/75">
              {[
                show.numberOfSeasons
                  ? `${show.numberOfSeasons} season${show.numberOfSeasons === 1 ? "" : "s"}`
                  : null,
                show.status,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </p>
          )}

          {rating && (
            <div className="mt-2.5 flex items-center justify-center gap-1.5">
              {rating.icon === "rt" ? (
                <span className="text-lg leading-none" title="Rotten Tomatoes">
                  🍅
                </span>
              ) : (
                <TmdbIcon className="h-5 w-5" />
              )}
              <span className="text-sm font-bold text-white/85">
                {rating.text}
              </span>
            </div>
          )}

          {progressStarted && (
            <div className="mt-5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-white/85">Watched</span>
                <span className="font-semibold text-white">
                  {watchedCount} of {totalCount}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/25">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------- Primary CTA: liquid-glass pill + favorite ---------- */}
      <div className="flex items-center gap-3 px-4 pt-4">
        {nextEpisode ? (
          <button
            type="button"
            onClick={() => openPlayer(nextEpisode)}
            className="glass-control flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 text-[15px] font-bold text-white transition hover:bg-white/[0.18] active:scale-[0.98]"
          >
            <Play className="h-4 w-4 shrink-0 fill-white" />
            <span className="truncate">{nextCtaLabel}</span>
          </button>
        ) : nextUnaired ? (
          <div
            aria-disabled
            className="glass-control flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 text-[15px] font-semibold text-white/55"
          >
            <span className="truncate">
              {daysUntil(nextUnaired.airDate) != null
                ? `Next episode in ${daysUntil(nextUnaired.airDate)} day${
                    daysUntil(nextUnaired.airDate) === 1 ? "" : "s"
                  }`
                : `Watch ${episodeCode(nextUnaired)} soon`}
            </span>
          </div>
        ) : rewatchStart ? (
          <button
            type="button"
            onClick={() => openPlayer(rewatchStart)}
            className="glass-control flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-white/10 px-4 text-[15px] font-bold text-white transition hover:bg-white/[0.18] active:scale-[0.98]"
          >
            <Play className="h-4 w-4 shrink-0 fill-white" />
            <span className="truncate">Rewatch {episodeCode(rewatchStart)}</span>
          </button>
        ) : (
          <div className="flex-1" />
        )}

        {hasWatchedEpisodes && (
          <FavoriteButton
            mediaType="tv"
            tmdbId={show.tmdbId}
            initialFavorite={initialFavorite}
            className="h-12 w-12"
          />
        )}
      </div>

      {rewatchCounts[0] > 0 && (
        <div className="mt-3 flex justify-center px-4">
          <span className="inline-flex items-center rounded-full bg-success/20 px-2.5 py-0.5 text-[11px] font-bold text-success ring-1 ring-success/40">
            Rewatched ×{rewatchCounts[0] + 1}
          </span>
        </div>
      )}

      {/* ---------- Episodes ---------- */}
      <section className="px-4 pt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[22px] font-extrabold tracking-tight text-white">
            Episodes
          </h2>
          <button
            onClick={handleAllEpisodesToggle}
            aria-label={
              allWatched ? "Clear all watched marks" : "Mark all episodes watched"
            }
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors",
              allWatched
                ? "border-success bg-success text-white"
                : "border-white/40 text-white/60"
            )}
          >
            <Check className="h-5 w-5" strokeWidth={3} />
          </button>
        </div>

        {/* Continue tracking / Finished */}
        {isFinished ? (
          <div className="relative mb-5 h-28 overflow-hidden rounded-2xl">
            {show.backdropPath && (
              <Image
                src={backdropUrl(show.backdropPath, "w780") ?? ""}
                alt=""
                fill
                sizes="100vw"
                className="object-cover opacity-40"
                unoptimized
              />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
              <p className="text-xl font-black text-primary">Finished</p>
              <p className="text-sm text-white/90">That&apos;s all, folks!</p>
            </div>
          </div>
        ) : nextEpisode ? (
          <div className="relative mb-5 flex h-28 w-full items-end overflow-hidden rounded-2xl">
            {nextEpisode.stillPath ? (
              <Image
                src={stillUrl(nextEpisode.stillPath, "w300") ?? ""}
                alt={nextEpisode.title}
                fill
                sizes="100vw"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="absolute inset-0 bg-secondary" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />
            <div className="relative flex w-full items-end justify-between gap-3 p-3">
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-bold uppercase tracking-wider text-primary">
                  {isPilotNext ? "Pilot" : "Up next"}
                </p>
                <p className="text-sm font-bold text-white">
                  {episodeCode(nextEpisode)}
                </p>
                <p className="truncate text-xs text-white/80">
                  {nextEpisode.title}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => openPlayer(nextEpisode)}
                  aria-label={`Play ${nextEpisode.title}`}
                  className="glass-control bg-white/10 flex h-10 w-10 items-center justify-center rounded-full text-white transition hover:bg-white/25 active:scale-95"
                >
                  <Play className="h-4 w-4 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={() => handleEpisodeToggle(nextEpisode, true)}
                  aria-label={`Mark ${nextEpisode.title} watched`}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black transition active:scale-95"
                >
                  <Check className="h-5 w-5" strokeWidth={3} />
                </button>
              </div>
            </div>
          </div>
        ) : nextUnaired ? (
          <div className="relative mb-5 flex h-28 w-full items-end overflow-hidden rounded-2xl">
            {nextUnaired.stillPath ? (
              <Image
                src={stillUrl(nextUnaired.stillPath, "w300") ?? ""}
                alt={nextUnaired.title}
                fill
                sizes="100vw"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="absolute inset-0 bg-secondary" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />
            <div className="relative flex w-full items-end justify-between p-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-white">
                  {episodeCode(nextUnaired)}
                </p>
                <p className="truncate text-xs text-white/80">
                  {nextUnaired.title}
                </p>
                {nextUnaired.airDate && (
                  <p className="text-[11px] text-primary">
                    {formatDate(nextUnaired.airDate)}
                  </p>
                )}
              </div>
              {daysUntil(nextUnaired.airDate) !== null && (
                <div className="flex w-14 flex-shrink-0 flex-col items-center justify-center">
                  <span className="text-2xl font-black leading-none text-white">
                    {daysUntil(nextUnaired.airDate)}
                  </span>
                  <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-white/70">
                    {daysUntil(nextUnaired.airDate) === 1 ? "day" : "days"}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Season accordions */}
        <div className="space-y-2.5">
          {seasons.map((season) => {
            const rewatchCount = rewatchCounts[season.seasonNumber] ?? 0;
            const expanded = expandedSeasons.has(season.seasonNumber);
            return (
              <div key={season.seasonNumber}>
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-2xl bg-card px-4 py-3.5",
                    season.complete && "border-b-4 border-success"
                  )}
                >
                  <button
                    onClick={() => toggleSeason(season.seasonNumber)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span className="truncate text-base font-bold text-white">
                      {seasonLabel(season.seasonNumber)}
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 flex-shrink-0 text-white transition-transform",
                        expanded && "rotate-180"
                      )}
                    />
                  </button>
                  <span className="flex-shrink-0 text-sm text-muted-foreground">
                    {season.watchedCount}/{season.total}
                  </span>
                  {rewatchCount > 0 && (
                    <span className="flex-shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-bold text-success ring-1 ring-success/30">
                      Rewatch ×{rewatchCount + 1}
                    </span>
                  )}
                  <button
                    onClick={() => handleSeasonBadge(season)}
                    aria-label={
                      season.complete
                        ? `Rewatch ${seasonLabel(season.seasonNumber)}`
                        : `Mark ${seasonLabel(season.seasonNumber)} watched`
                    }
                    className={cn(
                      "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors",
                      rewatchCount > 0
                        ? "bg-success text-sm font-black text-white"
                        : season.complete
                          ? "bg-success text-white"
                          : "border-2 border-white/25 text-white/40"
                    )}
                  >
                    {rewatchCount > 0 ? (
                      <span>×{rewatchCount + 1}</span>
                    ) : (
                      <Check className="h-5 w-5" strokeWidth={3} />
                    )}
                  </button>
                </div>

                {/* Episode list — flat rows on hairlines, like the reference */}
                {expanded && (
                  <div className="mt-1 divide-y divide-white/[0.07]">
                    {season.episodes.map((ep) => {
                      const watched = isWatched(ep);
                      const aired = isEpisodeAired(ep.airDate);
                      const key = watchKey(ep.seasonNumber, ep.episodeNumber);
                      const isNext = key === nextKey;

                      return (
                        <div
                          key={key}
                          className={cn(
                            "flex items-center gap-3 py-3",
                            !aired && !watched && "opacity-55"
                          )}
                        >
                          {/* Thumbnail doubles as the play target. */}
                          <button
                            type="button"
                            onClick={() => openPlayer(ep)}
                            disabled={!aired}
                            aria-label={
                              aired ? `Play ${ep.title}` : "Not aired yet"
                            }
                            className={cn(
                              "group relative h-[62px] w-[108px] shrink-0 overflow-hidden rounded-xl bg-secondary ring-1 ring-white/10",
                              aired
                                ? "cursor-pointer"
                                : "cursor-not-allowed grayscale"
                            )}
                          >
                            {ep.stillPath ? (
                              <Image
                                src={stillUrl(ep.stillPath, "w300") ?? ""}
                                alt={ep.title}
                                fill
                                sizes="108px"
                                className="object-cover"
                                unoptimized
                              />
                            ) : (
                              <span className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">
                                No img
                              </span>
                            )}

                            {aired && (
                              <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                                <Play className="h-5 w-5 fill-white text-white" />
                              </span>
                            )}

                            {watched && (
                              <span className="absolute bottom-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-success text-white shadow">
                                <Check className="h-3 w-3" strokeWidth={4} />
                              </span>
                            )}
                          </button>

                          <div className="min-w-0 flex-1">
                            <p
                              className={cn(
                                "text-[11px] font-bold uppercase tracking-wider",
                                isNext ? "text-primary" : "text-white/45"
                              )}
                            >
                              S{ep.seasonNumber} · E{ep.episodeNumber}
                            </p>
                            <p className="truncate text-[15px] font-semibold leading-tight text-white">
                              {ep.title}
                            </p>
                            <p className="mt-0.5 text-xs text-white/45">
                              {ep.airDate ? formatDate(ep.airDate) : null}
                              {ep.airDate && ep.runtime ? " · " : null}
                              {ep.runtime ? `${ep.runtime} min` : null}
                              {!aired && ep.airDate ? (
                                <span className="text-primary"> · Not aired yet</span>
                              ) : null}
                            </p>

                            {resumeLabel(ep) && !watched && (
                              <button
                                type="button"
                                onClick={() => openPlayer(ep)}
                                className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-bold text-primary ring-1 ring-primary/30 transition hover:bg-primary/25 active:scale-95"
                              >
                                <Play className="h-3 w-3 flex-shrink-0 fill-current" />
                                <span className="truncate">
                                  {resumeLabel(ep)}
                                </span>
                              </button>
                            )}

                            {watched && (
                              <div className="mt-1.5">
                                <EpisodeRating
                                  showTmdbId={show.tmdbId}
                                  seasonNumber={ep.seasonNumber}
                                  episodeNumber={ep.episodeNumber}
                                  initialRating={episodeRatings[key] ?? null}
                                />
                              </div>
                            )}
                          </div>

                          <DownloadButton
                            variant="icon"
                            item={{
                              type: "tv",
                              tmdbId: show.tmdbId,
                              season: ep.seasonNumber,
                              episode: ep.episodeNumber,
                              title: `${show.title} — S${ep.seasonNumber}E${ep.episodeNumber}`,
                              subtitle: ep.title,
                            }}
                          />

                          <button
                            type="button"
                            onClick={() => handleEpisodeToggle(ep, !watched)}
                            disabled={!aired && !watched}
                            aria-label={
                              watched ? "Mark unwatched" : "Mark watched"
                            }
                            className={cn(
                              "grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 transition-colors",
                              watched
                                ? "border-success bg-success text-white"
                                : !aired
                                  ? "cursor-not-allowed border-white/10 text-white/20"
                                  : "border-white/35 text-white/50 hover:border-white/60 hover:text-white"
                            )}
                          >
                            <Check className="h-4 w-4" strokeWidth={3} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- Stickers ---------- */}
      {stickerArt.length > 0 && (
        <section className="pt-8">
          <div className="flex items-center gap-1 px-4">
            <h2 className="text-[22px] font-extrabold tracking-tight text-white">
              Stickers
            </h2>
            <ChevronRight className="h-5 w-5 text-white/35" />
          </div>

          <div className="mt-3 flex items-end gap-3 overflow-x-auto px-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {stickerArt.map((src, i) => {
              const hero = i === stickerArt.length - 1 && stickerArt.length > 3;
              return (
                <div
                  key={src}
                  className="sticker-art shrink-0"
                  style={{
                    transform: `rotate(${i % 3 === 0 ? -3 : i % 3 === 1 ? 2 : -1}deg)`,
                  }}
                >
                  <Image
                    src={src}
                    alt=""
                    width={hero ? 240 : 180}
                    height={hero ? 240 : 180}
                    sizes={hero ? "(min-width: 640px) 240px" : "(min-width: 640px) 180px"}
                    className={cn(
                      "w-auto object-contain",
                      hero ? "h-[180px]" : "h-[135px]"
                    )}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---------- Storyline / Trailers / Details / Cast ---------- */}
      <section className="px-4 pt-6 pb-6">
        <button
          onClick={toggleFollow}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-full py-3 text-sm font-bold transition-all active:scale-[0.99]",
            following
              ? "glass-control bg-white/10 text-primary"
              : "bg-primary text-black shadow-[0_8px_24px_rgba(0,0,0,0.45)] hover:brightness-110"
          )}
        >
          {following ? (
            <>
              <BookmarkCheck className="h-4 w-4" strokeWidth={2.5} />
              In your watchlist
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" strokeWidth={2.5} />
              Add to watchlist
            </>
          )}
        </button>

        {(reviews?.rtScore != null ||
          reviews?.rtAudienceScore != null ||
          show.voteAverage) && (
          <div className="glass-panel mt-4 overflow-hidden rounded-3xl">
            <ScoreStrip
              className="border-y-0"
              rtScore={reviews?.rtScore}
              rtAudienceScore={reviews?.rtAudienceScore}
              voteAverage={show.voteAverage}
            />
          </div>
        )}

        {derivedScore && (
          <div className="mt-3 flex items-center gap-2 rounded-2xl bg-card px-4 py-3">
            <StarRatingDisplay value={derivedScore.value} size={16} />
            <span className="text-sm font-bold text-primary">
              {(derivedScore.value / 2).toFixed(1)}
            </span>
            <span className="text-xs text-muted-foreground">
              your avg · {derivedScore.count} episode
              {derivedScore.count === 1 ? "" : "s"} rated
            </span>
          </div>
        )}

        {show.overview && (
          <section className="mt-7">
            <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
              Storyline
            </h2>
            <p className="text-sm leading-relaxed text-white/85">
              {show.overview}
            </p>
          </section>
        )}

        {trailerPoster && (
          <section className="mt-7">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-[22px] font-extrabold tracking-tight text-white">
                Trailers
              </h2>
              {videos.length > 1 && (
                <span className="text-xs font-semibold text-white/40">
                  {videos.length} videos
                </span>
              )}
            </div>
            <a
              href={`https://www.youtube.com/watch?v=${trailerKey}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Watch ${show.title} trailer on YouTube`}
              className="group relative block overflow-hidden rounded-[1.75rem] shadow-[0_20px_60px_-16px_rgb(var(--theme)/0.55)] ring-1 ring-white/15 transition active:scale-[0.99]"
            >
              <div className="relative aspect-video bg-secondary">
                <Image
                  src={trailerPoster}
                  alt={`${show.title} trailer thumbnail`}
                  fill
                  sizes="(max-width: 480px) 100vw, 480px"
                  className="object-cover transition duration-300 group-hover:scale-[1.03]"
                  unoptimized
                />
                <div
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(to top, rgb(var(--theme-deep) / 0.7), transparent 55%, rgb(var(--theme-deep) / 0.25))",
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.18] shadow-[0_12px_32px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.45),0_0_44px_rgb(var(--theme)/0.5)] ring-1 ring-white/50 backdrop-blur-2xl transition group-hover:scale-105">
                    <span
                      aria-hidden
                      className="absolute left-3 top-2 h-4 w-8 rounded-full bg-white/40 blur-[6px]"
                    />
                    <Play className="ml-1 h-6 w-6 fill-white text-white" />
                  </span>
                </div>
              </div>
            </a>
            <p className="mt-2 text-sm text-white/80">{trailerName}</p>

            {extraTrailers.length > 0 && (
              <div className="-mx-4 mt-3 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {extraTrailers.map((v) => (
                  <a
                    key={v.id}
                    href={`https://www.youtube.com/watch?v=${v.key}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group w-40 shrink-0"
                  >
                    <div className="relative aspect-video overflow-hidden rounded-xl ring-1 ring-white/10">
                      <Image
                        src={`https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`}
                        alt={v.name ?? "Trailer"}
                        fill
                        sizes="160px"
                        className="object-cover transition duration-300 group-hover:scale-[1.04]"
                        unoptimized
                      />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.18] ring-1 ring-white/40 backdrop-blur-xl">
                          <Play className="ml-0.5 h-3.5 w-3.5 fill-white text-white" />
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 truncate text-[11px] font-medium text-white/60">
                      {v.name ?? "Trailer"}
                    </p>
                  </a>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="mt-7">
          <h2 className="mb-2.5 text-[22px] font-extrabold tracking-tight text-white">
            Details
          </h2>
          <div className="glass-panel rounded-3xl px-4 py-1.5">
            {show.genres.length > 0 && (
              <InfoRow label="Genres" value={show.genres.join(" · ")} />
            )}
            {show.firstAirDate && (
              <InfoRow label="First aired" value={formatDate(show.firstAirDate)} />
            )}
            {show.status && <InfoRow label="Status" value={show.status} />}
            {show.networks && show.networks.length > 0 && (
              <InfoRow label="Network" value={show.networks.join(", ")} />
            )}
            {creators.length > 0 && (
              <InfoRow label="Created by" value={creators.join(", ")} />
            )}
            {show.numberOfSeasons != null && (
              <InfoRow
                label="Seasons"
                value={[
                  `${show.numberOfSeasons} season${show.numberOfSeasons === 1 ? "" : "s"}`,
                  show.numberOfEpisodes != null
                    ? `${show.numberOfEpisodes} episodes`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            )}
            {show.episodeRuntime != null && (
              <InfoRow label="Runtime" value={`${show.episodeRuntime} min / episode`} />
            )}
          </div>
        </section>

        {cast.length > 0 && (
          <section className="mt-7">
            <h2 className="mb-2.5 text-[22px] font-extrabold tracking-tight text-white">
              Cast
            </h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {cast.map((person) => {
                const photo = posterUrl(person.profilePath, "w185");
                return (
                  <Link
                    key={person.id}
                    href={`/person/${person.id}`}
                    className="w-28 shrink-0"
                  >
                    <div className="relative h-36 overflow-hidden rounded-2xl bg-secondary ring-1 ring-white/10">
                      {photo ? (
                        <Image
                          src={photo}
                          alt={person.name}
                          fill
                          sizes="112px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xl font-black text-white/30">
                          {person.name.charAt(0)}
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 truncate text-xs font-semibold leading-tight text-white/90">
                      {person.name}
                    </p>
                    {person.character && (
                      <p className="truncate text-[11px] leading-tight text-white/40">
                        {person.character}
                      </p>
                    )}
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <WhereToWatch watch={watch} providers={providers} />

        {reviews && <CommunityReviews payload={reviews} />}

        <div className="mt-7">
          <DiscoverRail label="You Might Also Like" items={moreLikeThis} />
          <DiscoverRail label="Recommended for you" items={recommended} />
        </div>
      </section>

      {/* ---------- Rewatch dialog ---------- */}
      {rewatchSeason !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-card p-6">
            {rewatchSeason === "all" ? (
              <>
                <p className="mb-2 text-lg font-bold text-white">
                  Rewatch {show.title}?
                </p>
                <p className="mb-6 text-sm text-muted-foreground">
                  Every season&apos;s resume points clear so you can binge it again.
                  Your progress, ratings and watch history stay. Your series
                  rewatch badge becomes ×{(rewatchCounts[0] ?? 0) + 2}.
                </p>
              </>
            ) : (
              <>
                <p className="mb-2 text-lg font-bold text-white">
                  Rewatch {seasonLabel(rewatchSeason)}?
                </p>
                <p className="mb-6 text-sm text-muted-foreground">
                  {seasonLabel(rewatchSeason)}&apos;s resume points clear so you can
                  watch it again. Your progress, ratings and watch history stay.
                  Your rewatch badge becomes ×
                  {(rewatchCounts[rewatchSeason] ?? 0) + 2}.
                </p>
              </>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setRewatchSeason(null)}
                disabled={pending}
                className="flex-1 rounded-full border border-white/20 py-3 text-sm font-medium text-white"
              >
                Cancel
              </button>
              <button
                onClick={confirmRewatch}
                disabled={pending}
                className="flex-1 rounded-full bg-success py-3 text-sm font-bold text-white"
              >
                Rewatch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Mark-all confirm ---------- */}
      {confirmAllWatched && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-card p-6">
            <p className="mb-2 text-lg font-bold text-white">
              {allWatched ? "Clear watched marks?" : `Mark ${show.title} as watched?`}
            </p>
            <p className="mb-6 text-sm text-muted-foreground">
              {allWatched
                ? "Every episode loses its watched mark. Your ratings and watch history stay."
                : `Every aired episode of ${show.title} gets a watched mark and its resume point clears. Ratings and watch history stay.`}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmAllWatched(false)}
                className="flex-1 rounded-full border border-white/20 py-3 text-sm font-medium text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmAllWatched(false);
                  runAllEpisodesToggle();
                }}
                className="flex-1 rounded-full bg-primary py-3 text-sm font-bold text-black"
              >
                {allWatched ? "Clear marks" : "Mark watched"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Mark previous dialog ---------- */}
      {markPreviousTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-card p-6">
            <p className="mb-2 text-lg font-bold text-white">
              Mark previous episodes?
            </p>
            <p className="mb-6 text-sm text-muted-foreground">
              There are {previousUnwatchedAired(markPreviousTarget).length}{" "}
              earlier unwatched episode
              {previousUnwatchedAired(markPreviousTarget).length === 1
                ? ""
                : "s"}
              . Mark everything up to S{markPreviousTarget.seasonNumber}E
              {markPreviousTarget.episodeNumber} as watched?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void handleMarkPrevious(false)}
                className="flex-1 rounded-full border border-white/20 py-3 text-sm font-medium text-white"
              >
                Just this one
              </button>
              <button
                onClick={() => void handleMarkPrevious(true)}
                className="flex-1 rounded-full bg-primary py-3 text-sm font-bold text-black"
              >
                Yes, mark all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- VixSrc streaming player ---------- */}
      {playerEp && (
        <VixPlayer
          // Keyed on show only: episode advance swaps props on the SAME mount
          // so fullscreen (and the lock, audio graph, cast session) survives.
          // The player's src-change path resets per-episode state.
          key={`${show.tmdbId}`}
          overlaySlot={
            <>
              {/* Up-next autoplay overlay — inside the shell: fullscreen-safe. */}
              {upNext && playerEp && (
                <UpNextCard
                  episode={upNext}
                  currentSeason={playerEp.seasonNumber}
                  countdown={upNextCount}
                  onPlay={playUpNext}
                  onCancel={cancelUpNext}
                  showTitle={show.title}
                />
              )}

              {/* Glass Next: only after …96% AND countdown is gone (post-cancel). */}
              {nearEnd && manualNext && playerEp && !upNext && (
                <NextEpisodeFab onNext={playUpNext} />
              )}

              {/* End of the line: the played episode ended and there's no next
                  aired episode — keep the player open so the finale plays to
                  the true end. Small bottom-right card, auto-dismisses; X
                  dismisses only the card. */}
              {seriesEnded && playerEp && (
                <EndOfLineCard
                  episodeLabel={`${show.title} — S${playerEp.seasonNumber}E${playerEp.episodeNumber}`}
                  onDismiss={() => setSeriesEnded(false)}
                />
              )}
            </>
          }
          src={vixTvUrl(
            show.tmdbId,
            playerEp.seasonNumber,
            playerEp.episodeNumber
          )}
          type="tv"
          tmdbId={show.tmdbId}
          season={playerEp.seasonNumber}
          episode={playerEp.episodeNumber}
          title={`${show.title} — S${playerEp.seasonNumber}E${playerEp.episodeNumber} ${playerEp.title}`}
          initialPosition={playbackFor(playerEp)?.positionSeconds}
          autoResume={Boolean(playbackFor(playerEp))}
          onEvent={handlePlayerEvent}
          onNearEnd={() => setNearEnd(true)}
          onClose={() => {
            playerSessionRef.current += 1;
            setPlayerEp(null);
            setSeriesEnded(false);
            setManualNext(null);
            setNearEnd(false);
            setUpNext(null);
            setUpNextCount(0);
            // Re-fetch playback server state so resume labels reflect saves.
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/[0.06] py-2.5 text-sm last:border-0">
      <span className="shrink-0 text-white/45">{label}</span>
      <span className="text-right font-medium text-white">{value}</span>
    </div>
  );
}
