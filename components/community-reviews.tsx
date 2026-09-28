"use client";

import { useMemo, useState } from "react";
import type {
  CommunityReview,
  ReviewSentiment,
  ReviewSource,
  ReviewsPayload,
} from "@/lib/reviews";
import { cn } from "@/lib/utils";
import { FreshIcon, RottenIcon } from "@/components/rt-icons";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MessageSquare,
  Star,
  ThumbsUp,
  MessagesSquare,
} from "lucide-react";

type Filter = "all" | "fresh" | "rotten" | ReviewSource;

/**
 * RT, TMDB and Reddit each mint their own ids, so two different sources can
 * legitimately hand back the same numeric id. Keying on the raw id collided
 * in React and silently dropped rows — namespace it.
 */
function reviewKey(r: CommunityReview) {
  return `${r.source}:${r.id}`;
}

function dedupe(reviews: CommunityReview[]) {
  const seen = new Set<string>();
  const out: CommunityReview[] = [];
  for (const r of reviews) {
    const key = reviewKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function VerdictIcon({
  sentiment,
  size = "md",
}: {
  sentiment: ReviewSentiment;
  size?: "sm" | "md" | "lg";
}) {
  const cls =
    size === "lg" ? "h-8 w-8" : size === "sm" ? "h-5 w-5" : "h-6 w-6";
  if (sentiment === "fresh") return <FreshIcon className={cls} />;
  if (sentiment === "rotten") return <RottenIcon className={cls} />;
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full bg-[#ff4500]/15 text-[#ff6a33]",
        size === "lg" ? "h-8 w-8 text-sm" : "h-6 w-6 text-[10px]"
      )}
    >
      r/
    </div>
  );
}

function formatWhen(iso: string | null) {
  if (!iso) return null;
  // RT sometimes sends "03/20/2024" or "Jul 24"
  if (!iso.includes("T") && !/^\d{4}-/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatScore(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function starsFromTen(rating: number) {
  return (Math.round(rating) / 2).toFixed(1);
}

function sourceLabel(s: ReviewSource) {
  if (s === "rt") return "RT";
  if (s === "tmdb") return "TMDB";
  return "Reddit";
}

/** Pastel avatar disc with the author's initial, tinted per source. */
function AuthorAvatar({
  author,
  source,
}: {
  author: string;
  source: ReviewSource;
}) {
  const initial = (author.trim().charAt(0) || "?").toUpperCase();
  const tint =
    source === "rt"
      ? "bg-[#fa320a]/15 text-[#fa320a]"
      : source === "tmdb"
        ? "bg-primary/15 text-primary"
        : "bg-[#ff4500]/15 text-[#ff6a33]";
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-black",
        tint
      )}
    >
      {initial}
    </div>
  );
}

/* ── Critics consensus (RT featured card) ──────────────────────── */

function ConsensusCard({ review }: { review: CommunityReview }) {
  return (
    <div className="m-2 rounded-2xl bg-gradient-to-br from-[#2a120c] to-[#1a1a1c] p-4 ring-1 ring-[#fa320a]/35">
      <div className="flex items-start gap-3">
        <VerdictIcon sentiment={review.sentiment} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#fa320a]">
            Critics consensus
          </p>
          <p className="mt-1.5 text-[15px] font-medium leading-snug text-white/95">
            &ldquo;{review.content}&rdquo;
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/45">
            {review.score != null && (
              <span className="font-bold text-[#fa320a]">
                {review.score}% Tomatometer
              </span>
            )}
            {review.url && (
              <a
                href={review.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-white/60 hover:text-white"
              >
                Rotten Tomatoes
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Single review row ─────────────────────────────────────────── */

function ReviewRow({ review }: { review: CommunityReview }) {
  const [open, setOpen] = useState(false);
  const long = review.content.length > 200;
  const when = formatWhen(review.createdAt);

  return (
    <div className="flex gap-3 px-4 py-4">
      <AuthorAvatar author={review.author} source={review.source} />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="truncate text-sm font-semibold text-white">
                {review.author}
              </span>
              {review.rating != null && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                  <Star className="h-2.5 w-2.5 fill-primary" />
                  {starsFromTen(review.rating)}
                </span>
              )}
              {review.sentiment && (
                <VerdictIcon sentiment={review.sentiment} size="sm" />
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px]">
              <span
                className={cn(
                  "font-semibold",
                  review.source === "rt" && "text-[#fa320a]/90",
                  review.source === "tmdb" && "text-primary/80",
                  review.source === "reddit" && "text-[#ff6a33]/90"
                )}
              >
                {sourceLabel(review.source)}
              </span>
              {review.meta && (
                <span className="max-w-[12rem] truncate rounded-full bg-white/[0.05] px-1.5 py-px text-[10px] text-white/45">
                  {review.meta}
                </span>
              )}
              {when && <span className="text-white/30">{when}</span>}
            </p>
          </div>

          {review.url && (
            <a
              href={review.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.04] text-white/40 transition hover:bg-white/10 hover:text-white"
              aria-label="Open original"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        {review.title && (
          <h3 className="mt-2 text-[14px] font-semibold leading-snug text-white/95">
            {review.title}
          </h3>
        )}

        <p
          className={cn(
            "mt-1.5 text-[13px] leading-[1.55] whitespace-pre-wrap text-white/65",
            !open && long && "line-clamp-3"
          )}
        >
          {review.content}
        </p>

        <div className="mt-1.5 flex items-center gap-3">
          {long && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-xs font-bold text-primary"
            >
              {open ? "Show less" : "Read more"}
            </button>
          )}
          {review.source === "reddit" && review.score != null && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-white/35">
              <ThumbsUp className="h-3 w-3" />
              {formatScore(review.score)}
            </span>
          )}
          {review.source === "reddit" && review.commentCount != null && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-white/35">
              <MessagesSquare className="h-3 w-3" />
              {formatScore(review.commentCount)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main export ───────────────────────────────────────────────── */

/**
 * One section, one control. Scores live in `ScoreStrip` above, so this only
 * carries the text reviews: an inline filter row, the consensus card, a short
 * preview, and a single expand/collapse button — the old "See all N" in the
 * header and "Show all N reviews" in the footer did the same job twice, and
 * the modal they opened hid the filters people were looking for.
 */
const PREVIEW_COUNT = 4;

export function CommunityReviews({
  payload,
}: {
  payload: ReviewsPayload;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);

  const reviews = useMemo(() => dedupe(payload.reviews), [payload.reviews]);

  const tallies = useMemo(() => {
    const t = { all: 0, fresh: 0, rotten: 0, rt: 0, tmdb: 0, reddit: 0 };
    for (const r of reviews) {
      t.all += 1;
      if (r.source === "rt") t.rt += 1;
      else if (r.source === "tmdb") t.tmdb += 1;
      else if (r.source === "reddit") t.reddit += 1;
      if (r.sentiment === "fresh") t.fresh += 1;
      else if (r.sentiment === "rotten") t.rotten += 1;
    }
    return t;
  }, [reviews]);

  const realReddit = useMemo(
    () =>
      reviews.filter(
        (r) => r.source === "reddit" && r.id !== "reddit-browse"
      ),
    [reviews]
  );

  const visible = useMemo(() => {
    if (filter === "all") return reviews;
    if (filter === "fresh") return reviews.filter((r) => r.sentiment === "fresh");
    if (filter === "rotten")
      return reviews.filter((r) => r.sentiment === "rotten");
    return reviews.filter((r) => r.source === filter);
  }, [reviews, filter]);

  const consensus = visible.filter((r) => r.featured);
  const rows = visible.filter((r) => !r.featured);
  const shownRows = expanded ? rows : rows.slice(0, PREVIEW_COUNT);
  const expandable = rows.length > PREVIEW_COUNT;

  if (reviews.length === 0) return null;

  const tabs = (
    [
      { id: "all" as const, label: "All", n: tallies.all },
      { id: "fresh" as const, label: "Fresh", n: tallies.fresh },
      { id: "rotten" as const, label: "Rotten", n: tallies.rotten },
      { id: "rt" as const, label: "RT", n: tallies.rt },
      { id: "tmdb" as const, label: "Fans", n: tallies.tmdb },
      { id: "reddit" as const, label: "Reddit", n: realReddit.length },
    ] satisfies { id: Filter; label: string; n: number }[]
  ).filter((t) => t.id === "all" || t.n > 0);

  const subline = [
    `${tallies.all} review${tallies.all === 1 ? "" : "s"}`,
    tallies.rt > 0 ? `${tallies.rt} critic${tallies.rt === 1 ? "" : "s"}` : null,
    tallies.tmdb > 0 ? `${tallies.tmdb} fan${tallies.tmdb === 1 ? "" : "s"}` : null,
    realReddit.length > 0 ? `${realReddit.length} Reddit` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const pick = (id: Filter) => {
    setFilter(id);
    setExpanded(false);
  };

  const scored = tallies.fresh + tallies.rotten;

  return (
    <section className="mt-7">
      <div className="mb-3">
        <h2 className="text-[22px] font-extrabold tracking-tight text-white">
          Reviews
        </h2>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {subline}
        </p>
      </div>

      {/* Split of verdicts — distribution, not the percentages ScoreStrip shows. */}
      {scored > 0 && (
        <div className="mb-3">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="bg-[#6ac04a] transition-[width] duration-500"
              style={{ width: `${(tallies.fresh / scored) * 100}%` }}
            />
            <div className="flex-1 bg-[#fa320a]" />
          </div>
          <p className="mt-1.5 text-[11px] text-white/40">
            {tallies.fresh} fresh · {tallies.rotten} rotten
          </p>
        </div>
      )}

      {tabs.length > 1 && (
        <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => pick(tab.id)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition-colors",
                  active
                    ? tab.id === "rotten"
                      ? "bg-[#6ac04a] text-black"
                      : tab.id === "reddit"
                        ? "bg-[#ff4500] text-white"
                        : tab.id === "fresh" || tab.id === "rt"
                          ? "bg-[#fa320a] text-white"
                          : "bg-primary text-black"
                    : "bg-white/[0.05] text-white/55 hover:text-white"
                )}
              >
                {tab.id === "fresh" && (
                  <FreshIcon className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                )}
                {tab.id === "rotten" && (
                  <RottenIcon className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                )}
                {tab.label}
                <span className="ml-1 tabular-nums opacity-75">{tab.n}</span>
              </button>
            );
          })}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="glass-panel rounded-3xl px-4 py-6 text-center">
          <MessageSquare className="mx-auto h-5 w-5 text-white/25" />
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing in this filter yet.
          </p>
        </div>
      ) : (
        <>
          <div className="glass-panel divide-y divide-white/[0.05] overflow-hidden rounded-3xl">
            {consensus.map((r) => (
              <ConsensusCard key={reviewKey(r)} review={r} />
            ))}
            {shownRows.map((r) => (
              <ReviewRow key={reviewKey(r)} review={r} />
            ))}
          </div>

          {expandable && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-full py-3 text-sm font-bold text-white/70 ring-1 ring-white/12 transition hover:text-white hover:ring-white/25 active:scale-[0.99]"
            >
              {expanded ? "Show less" : `Show all ${visible.length} reviews`}
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </>
      )}
    </section>
  );
}
