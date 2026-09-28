"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  CommunityReview,
  ReviewSentiment,
  ReviewSource,
  ReviewsPayload,
} from "@/lib/reviews";
import { cn } from "@/lib/utils";
import {
  FreshIcon,
  RottenIcon,
  PopcornIcon,
} from "@/components/rt-icons";
import {
  ChevronRight,
  ExternalLink,
  MessageSquare,
  X,
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

/* ── Score chip ────────────────────────────────────────────────── */

function ScoreChip({
  icon,
  value,
  label,
  size = "md",
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span
        className={cn(
          "font-black leading-none text-white",
          size === "sm" ? "text-sm" : "text-base"
        )}
      >
        {value}
      </span>
      <span className="text-[9px] font-bold uppercase tracking-wide text-white/35">
        {label}
      </span>
    </div>
  );
}

/* ── Main export ───────────────────────────────────────────────── */

const PREVIEW_COUNT = 3;

export function CommunityReviews({
  payload,
  mediaTitle,
}: {
  payload: ReviewsPayload;
  mediaTitle?: string;
}) {
  const { rtScore, rtAudienceScore, rtState, counts } = payload;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const reviews = useMemo(() => dedupe(payload.reviews), [payload.reviews]);

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

  const preview = reviews.slice(0, PREVIEW_COUNT);
  const consensus = preview.filter((r) => r.featured);
  const previewRows = preview.filter((r) => !r.featured);
  const hasAnyScore = rtScore != null || rtAudienceScore != null;
  const hasContent = hasAnyScore || reviews.length > 0;

  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  if (!hasContent) return null;

  const rtFresh =
    rtScore != null ? rtScore >= 60 : rtState?.includes("fresh") ?? null;

  const tabs = (
    [
      { id: "all" as const, label: "All", n: reviews.length },
      { id: "fresh" as const, label: "Fresh", n: counts.fresh },
      { id: "rotten" as const, label: "Rotten", n: counts.rotten },
      { id: "rt" as const, label: "RT", n: counts.rt },
      { id: "tmdb" as const, label: "Fans", n: counts.tmdb },
      {
        id: "reddit" as const,
        label: "Reddit",
        n: Math.max(counts.reddit, realReddit.length),
      },
    ] satisfies { id: Filter; label: string; n?: number }[]
  ).filter((t) => t.id === "all" || (t.n != null && t.n > 0));

  const subline = [
    counts.rt > 0 ? `${counts.rt} critic${counts.rt === 1 ? "" : "s"}` : null,
    counts.tmdb > 0 ? `${counts.tmdb} fan` : null,
    realReddit.length > 0 ? `${realReddit.length} Reddit` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <section className="mt-7">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[22px] font-extrabold tracking-tight text-white">
              Reviews
            </h2>
            {subline && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {subline}
              </p>
            )}
          </div>
          {reviews.length > 0 && (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="inline-flex shrink-0 items-center gap-0.5 text-xs font-bold text-primary"
            >
              See all {reviews.length}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {hasAnyScore && (
          <div className="glass-panel mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-3xl px-4 py-3">
            {rtScore != null && (
              <ScoreChip
                icon={
                  rtFresh ? (
                    <FreshIcon className="h-6 w-6" />
                  ) : (
                    <RottenIcon className="h-6 w-6" />
                  )
                }
                value={`${rtScore}%`}
                label="Tomatometer"
              />
            )}
            {rtAudienceScore != null && (
              <ScoreChip
                icon={<PopcornIcon className="h-6 w-6" />}
                value={`${rtAudienceScore}%`}
                label="Audience"
              />
            )}
          </div>
        )}

        {reviews.length === 0 ? (
          <div className="glass-panel rounded-3xl px-4 py-6 text-center">
            <MessageSquare className="mx-auto h-5 w-5 text-white/25" />
            <p className="mt-2 text-sm text-muted-foreground">
              No reviews pulled in yet.
            </p>
          </div>
        ) : (
          <div className="glass-panel overflow-hidden rounded-3xl divide-y divide-white/[0.05]">
            {consensus.map((r) => (
              <ConsensusCard key={reviewKey(r)} review={r} />
            ))}
            {previewRows.map((r) => (
              <ReviewRow key={reviewKey(r)} review={r} />
            ))}
          </div>
        )}

        {reviews.length > preview.length && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="mt-3 flex w-full items-center justify-center gap-1 rounded-full py-3 text-sm font-bold text-white/70 ring-1 ring-white/12 transition hover:text-white hover:ring-white/25 active:scale-[0.99]"
          >
            Show all {reviews.length} reviews
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </section>

      {/* ── Sheet ── */}
      {sheetOpen && (
        <div className="fixed inset-0 z-[80] flex flex-col">
          <button
            type="button"
            aria-label="Close reviews"
            className="absolute inset-0 bg-black/75 backdrop-blur-[3px]"
            onClick={() => setSheetOpen(false)}
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Reviews"
            className={cn(
              "relative mt-auto flex max-h-[93dvh] w-full flex-col",
              "rounded-t-[1.35rem] bg-[#0a0a0c]",
              "shadow-[0_-20px_60px_rgba(0,0,0,0.65)]",
              "ring-1 ring-white/[0.08]",
              "animate-in slide-in-from-bottom duration-300"
            )}
          >
            <div className="flex justify-center pt-2.5 pb-1">
              <div className="h-1 w-10 rounded-full bg-white/15" />
            </div>

            <div className="shrink-0 border-b border-white/[0.06] px-4 pb-3 pt-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-black tracking-tight text-white">
                    Reviews
                  </h2>
                  {mediaTitle && (
                    <p className="truncate text-xs text-muted-foreground">
                      {mediaTitle}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {tabs.map((tab) => {
                  const active = filter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setFilter(tab.id)}
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
                      {tab.n != null && (
                        <span className="ml-1 tabular-nums opacity-75">
                          {tab.n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-safe-page">
              {visible.length === 0 ? (
                <div className="px-6 py-16 text-center">
                  <p className="text-sm text-muted-foreground">
                    Nothing in this filter yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.05]">
                  {visible.map((r) =>
                    r.featured ? (
                      <ConsensusCard key={reviewKey(r)} review={r} />
                    ) : (
                      <ReviewRow key={reviewKey(r)} review={r} />
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
