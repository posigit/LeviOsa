import { PosterGridSkeleton, Skeleton } from "@/components/skeletons";
import { StickyChrome } from "@/components/sticky-chrome";

export default function RankedYearLoading() {
  return (
    <div
      className="min-h-dvh bg-black pb-nav-page"
      role="status"
      aria-label="Loading ranked titles"
    >
      <StickyChrome contentClassName="px-4 pt-3 pb-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-32" />
          </div>
        </div>
      </StickyChrome>
      <div className="px-4 pt-4">
        <PosterGridSkeleton count={12} className="gap-x-2 gap-y-4" />
      </div>
      <span className="sr-only">Loading titles…</span>
    </div>
  );
}
