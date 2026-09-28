import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { StickyChrome } from "@/components/sticky-chrome";

/** Base pulse block — matches card surfaces in every theme */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-secondary", className)}
      style={style}
      aria-hidden
    />
  );
}

/** Watch-list row: still thumb + title pill + episode line + check circle */
export function ShowListRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-card p-2.5">
      <Skeleton className="h-[72px] w-[116px] flex-shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2 py-0.5">
        <Skeleton className="h-6 w-28 rounded-full" />
        <Skeleton className="h-4 w-36" />
      </div>
      <Skeleton className="h-11 w-11 flex-shrink-0 rounded-full bg-muted" />
    </div>
  );
}

/** 2:3 poster tile for grids */
export function PosterTileSkeleton({ className }: { className?: string }) {
  return (
    <Skeleton
      className={cn("w-full overflow-hidden rounded-md", className)}
      style={{ aspectRatio: "2 / 3" }}
    />
  );
}

/** 3-column poster grid. Pass `className` to match the page's own gap. */
export function PosterGridSkeleton({
  count = 6,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-3 gap-2", className)}>
      {Array.from({ length: count }, (_, i) => (
        <PosterTileSkeleton key={i} />
      ))}
    </div>
  );
}

/** WATCH LIST / UPCOMING tab bar */
export function TabsHeaderSkeleton() {
  return (
    <div className="relative flex">
      <div className="relative flex-1 pb-3 pt-2">
        <Skeleton className="mx-auto h-4 w-24" />
        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground/40" />
      </div>
      <div className="flex-1 pb-3 pt-2">
        <Skeleton className="mx-auto h-4 w-20 opacity-50" />
      </div>
    </div>
  );
}

/** Centred pill label (SectionLabel) — used by shows/movies/explore rails */
export function SectionLabelSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("mb-3 mt-2 flex justify-center", className)}>
      <Skeleton className="h-7 w-28 rounded-full bg-muted" />
    </div>
  );
}

/** Left-aligned 22px bold section heading (Cast / Storyline / Information) */
export function SectionHeadingSkeleton({
  width = "w-44",
  className,
}: {
  width?: string;
  className?: string;
}) {
  return (
    <Skeleton className={cn("mb-4 h-6 bg-foreground/15", width, className)} />
  );
}

/** Explore search input */
export function SearchBarSkeleton() {
  return <Skeleton className="mb-4 h-11 w-full rounded-xl bg-card" />;
}

/** Horizontal poster rail — matches DiscoverRail's w-[7.25rem] 2:3 cards */
export function PosterRailSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="-mx-4 mb-6 flex gap-2.5 overflow-hidden px-4">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          key={i}
          className="w-[7.25rem] flex-shrink-0 overflow-hidden rounded-lg"
          style={{ aspectRatio: "2 / 3" }}
        />
      ))}
    </div>
  );
}

/** Circular cast/crew avatars under a rail */
export function AvatarRailSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="-mx-4 mb-6 flex gap-3 overflow-hidden px-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="w-28 flex-shrink-0">
          <Skeleton className="aspect-square w-full rounded-full bg-foreground/12" />
          <Skeleton className="mx-auto mt-2 h-3.5 w-20" />
          <Skeleton className="mx-auto mt-1.5 h-3 w-14 bg-foreground/10" />
        </div>
      ))}
    </div>
  );
}

/** The ScoreStrip glass panel that sits under the detail CTA row */
export function ScoreStripSkeleton() {
  return (
    <div className="mb-6 rounded-2xl bg-card p-4">
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-14 bg-foreground/10" />
            <Skeleton className="h-6 w-12 bg-foreground/15" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Label/value rows used by the Information (Details) section */
export function InfoRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3 w-24 bg-foreground/10" />
          <Skeleton className="h-5 w-40 bg-foreground/15" />
        </div>
      ))}
    </div>
  );
}

/** Floating back + action circles that sit over a full-bleed hero */
function FloatChromeSkeleton() {
  return (
    <>
      <div className="absolute left-4 top-safe-float h-10 w-10 rounded-full bg-background/50" />
      <div className="absolute right-4 top-safe-float flex gap-2">
        <div className="h-10 w-10 rounded-full bg-background/50" />
        <div className="h-10 w-10 rounded-full bg-background/50" />
      </div>
    </>
  );
}

/** Show/movie detail backdrop + title block — 72dvh frame shared by both */
export function DetailHeroSkeleton() {
  return (
    <div className="relative h-[72dvh] max-h-[720px] min-h-[460px] w-full overflow-hidden bg-card">
      <div className="absolute inset-0 animate-pulse bg-secondary" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/45 to-transparent" />
      <FloatChromeSkeleton />
      <div className="absolute inset-x-0 bottom-0 space-y-3 px-5 pb-6">
        <Skeleton className="h-9 w-56 max-w-[75%] bg-foreground/15" />
        <Skeleton className="h-4 w-44 bg-foreground/10" />
        <Skeleton className="h-4 w-32 bg-foreground/10" />
        <div className="space-y-2 pt-3">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-16 bg-foreground/10" />
            <Skeleton className="h-4 w-14 bg-foreground/10" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full bg-foreground/10" />
        </div>
      </div>
    </div>
  );
}

// ─── Full-page loading shells ───────────────────────────────────────────────

export function ShowsPageSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background px-4 pb-nav-page"
      role="status"
      aria-label="Loading shows"
    >
      <StickyChrome contentClassName="pt-2">
        <div className="relative">
          <TabsHeaderSkeleton />
          <div className="absolute right-0 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full bg-secondary" />
        </div>
      </StickyChrome>
      <section className="mb-6">
        <div className="relative mb-3 mt-2 flex justify-center">
          <SectionLabelSkeleton className="m-0" />
          <div className="absolute right-0 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-secondary" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <ShowListRowSkeleton key={i} />
          ))}
        </div>
      </section>
      <section className="mb-6">
        <SectionLabelSkeleton className="mt-0" />
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <ShowListRowSkeleton key={i} />
          ))}
        </div>
      </section>
      <span className="sr-only">Loading shows…</span>
    </div>
  );
}

export function MoviesPageSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background px-4 pb-nav-page"
      role="status"
      aria-label="Loading movies"
    >
      <StickyChrome contentClassName="pt-2">
        <div className="relative">
          <TabsHeaderSkeleton />
          <div className="absolute right-0 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full bg-secondary" />
        </div>
      </StickyChrome>
      <section className="mb-6">
        <div className="relative mb-3 mt-2 flex justify-center">
          <SectionLabelSkeleton className="m-0" />
          <div className="absolute right-0 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full bg-secondary" />
        </div>
        <PosterGridSkeleton count={6} />
      </section>

      {/* Surprise / Watch Later tools sit between the two grids */}
      <section className="mb-6">
        <div className="flex gap-2">
          <Skeleton className="h-12 flex-1 rounded-full bg-foreground/12" />
          <Skeleton className="h-12 flex-1 rounded-full bg-foreground/12" />
        </div>
      </section>

      <section className="mb-6">
        <SectionLabelSkeleton className="mt-0" />
        <PosterGridSkeleton count={6} />
      </section>
      <span className="sr-only">Loading movies…</span>
    </div>
  );
}

export function ExplorePageSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background pb-nav-page"
      role="status"
      aria-label="Loading explore"
    >
      <StickyChrome contentClassName="px-4 pt-3 pb-1">
        <SearchBarSkeleton />
      </StickyChrome>

      {/* FeedHero is the first block on both tabs */}
      <div className="-mx-4 mb-6 h-[46dvh] max-h-[440px] min-h-[300px] overflow-hidden bg-card">
        <div className="h-full w-full animate-pulse bg-secondary" />
      </div>

      <div className="px-4">
        <div className="mb-5 flex gap-2 overflow-hidden">
          <Skeleton className="h-10 w-20 flex-shrink-0 rounded-full bg-foreground/15" />
          <Skeleton className="h-10 w-24 flex-shrink-0 rounded-full" />
        </div>

        <section className="mb-7">
          <Skeleton className="mb-3 h-6 w-32" />
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="w-[11.5rem] flex-shrink-0">
                <Skeleton className="w-full rounded-xl" style={{ aspectRatio: "16 / 10" }} />
                <Skeleton className="mt-2 h-4 w-24" />
                <Skeleton className="mt-1.5 h-3 w-32" />
              </div>
            ))}
          </div>
        </section>

        <section className="mb-7">
          <Skeleton className="mb-3 h-6 w-28" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </section>

        <section className="mb-7">
          <SectionLabelSkeleton />
          <PosterRailSkeleton count={5} />
        </section>
        <section className="mb-6">
          <SectionLabelSkeleton className="mt-0" />
          <PosterRailSkeleton count={6} />
        </section>
      </div>
      <span className="sr-only">Loading explore…</span>
    </div>
  );
}

export function ProfilePageSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background pb-nav-page"
      role="status"
      aria-label="Loading profile"
    >
      <div className="relative mb-6">
        <div className="relative h-profile-hero w-full overflow-hidden bg-card">
          <div className="absolute inset-0 animate-pulse bg-secondary" />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-background/20" />
        </div>
        <div className="relative z-10 -mt-12 flex items-end gap-3 px-4">
          <Skeleton className="h-24 w-24 flex-shrink-0 overflow-hidden rounded-full ring-4 ring-background" />
          <div className="min-w-0 flex-1 space-y-2 pb-1">
            <Skeleton className="h-7 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      </div>

      <div className="px-4">
        {/* Continue watching / recently streamed shelf */}
        <section className="mb-8">
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="w-[15rem] flex-shrink-0">
                <Skeleton className="w-full rounded-xl" style={{ aspectRatio: "16 / 9" }} />
                <Skeleton className="mt-2 h-4 w-28" />
              </div>
            ))}
          </div>
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-36" />
          <div className="rounded-2xl bg-card p-4">
            <Skeleton className="h-11 w-full" />
          </div>
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-24" />
          <div className="rounded-2xl bg-card p-4">
            <div className="grid grid-cols-2 gap-x-3 gap-y-5">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-32" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-28" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-28" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-40" />
          <PosterRailSkeleton count={4} />
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-28" />
          <PosterRailSkeleton count={4} />
        </section>

        <section className="mb-8">
          <SectionHeadingSkeleton width="w-24" />
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        </section>

        {Array.from({ length: 4 }, (_, i) => (
          <section key={i} className="mb-8">
            <SectionHeadingSkeleton width={i % 2 === 0 ? "w-32" : "w-44"} />
            <PosterRailSkeleton count={4} />
          </section>
        ))}
      </div>
      <span className="sr-only">Loading profile…</span>
    </div>
  );
}

export function ShowDetailSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background pb-safe-page"
      role="status"
      aria-label="Loading show"
    >
      <DetailHeroSkeleton />

      {/* CTA pill + favorite */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <Skeleton className="h-12 flex-1 rounded-full bg-foreground/10" />
        <Skeleton className="h-12 w-12 rounded-full bg-foreground/10" />
      </div>

      <div className="px-4 pt-7">
        <ScoreStripSkeleton />
        <SectionHeadingSkeleton width="w-36" />
        <div className="mb-6 space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-5/6" />
        </div>
        <SectionHeadingSkeleton width="w-32" />
        <PosterRailSkeleton count={5} />
        <SectionHeadingSkeleton width="w-28" />
        <InfoRowsSkeleton rows={5} />
        <div className="mt-7">
          <SectionHeadingSkeleton width="w-32" />
          <AvatarRailSkeleton count={5} />
        </div>
      </div>
      <span className="sr-only">Loading show…</span>
    </div>
  );
}

export function MovieDetailSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background pb-safe-page"
      role="status"
      aria-label="Loading movie"
    >
      <DetailHeroSkeleton />

      {/* Watch / rewatch / download row */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <Skeleton className="h-12 flex-1 rounded-full bg-foreground/10" />
        <Skeleton className="h-12 w-12 rounded-full bg-foreground/10" />
      </div>

      <div className="px-4 pt-6">
        <ScoreStripSkeleton />
        <SectionHeadingSkeleton width="w-36" />
        <div className="mb-6 space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-5/6" />
        </div>
        <SectionHeadingSkeleton width="w-32" />
        <PosterRailSkeleton count={5} />
        <SectionHeadingSkeleton width="w-28" />
        <InfoRowsSkeleton rows={7} />
        <div className="mt-7">
          <SectionHeadingSkeleton width="w-24" />
          <AvatarRailSkeleton count={5} />
        </div>
      </div>
      <span className="sr-only">Loading movie…</span>
    </div>
  );
}

// ─── Person (actor / director) ──────────────────────────────────────────────

export function PersonDetailSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background pb-safe-page"
      role="status"
      aria-label="Loading person"
    >
      <div className="relative h-[72dvh] max-h-[720px] min-h-[460px] w-full overflow-hidden bg-card">
        <div className="absolute inset-0 animate-pulse bg-secondary" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/45 to-transparent" />
        <FloatChromeSkeleton />
        <div className="absolute inset-x-0 bottom-0 space-y-3 px-5 pb-7">
          <Skeleton className="h-10 w-64 max-w-[80%] bg-foreground/15" />
          <Skeleton className="h-4 w-52 bg-foreground/10" />
        </div>
      </div>

      <div className="px-4 pt-6">
        <Skeleton className="mb-7 h-24 w-full rounded-2xl" />

        <SectionHeadingSkeleton width="w-36" />
        <div className="mb-7 space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>

        <SectionHeadingSkeleton width="w-32" />
        <PosterRailSkeleton count={5} />

        <SectionHeadingSkeleton width="w-36" />
        <PosterRailSkeleton count={5} />

        <SectionHeadingSkeleton width="w-40" />
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-[5.5rem] w-14 flex-shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading person…</span>
    </div>
  );
}

export function PersonCreditsSkeleton() {
  return (
    <div
      className="min-h-dvh bg-background pb-safe-page"
      role="status"
      aria-label="Loading filmography"
    >
      <StickyChrome contentClassName="pt-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-6 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-9 w-9 rounded-full" />
          </div>
        </div>
      </StickyChrome>

      <div className="px-4 pt-4">
        {Array.from({ length: 2 }, (_, s) => (
          <section key={s} className="mb-8">
            <SectionHeadingSkeleton width={s === 0 ? "w-28" : "w-24"} />
            <div className="space-y-4">
              {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-[5.5rem] w-14 flex-shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-4 w-4 rounded-full bg-foreground/10" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <span className="sr-only">Loading filmography…</span>
    </div>
  );
}
