import { Skeleton } from "@/components/skeletons";
import { StickyChrome } from "@/components/sticky-chrome";

export default function WatchHistoryLoading() {
  return (
    <div
      className="min-h-dvh bg-black pb-nav-page"
      role="status"
      aria-label="Loading watch history"
    >
      <StickyChrome contentClassName="px-4 pt-3 pb-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-6 w-40" />
        </div>
      </StickyChrome>
      <div className="space-y-3 px-4 pt-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-16 w-11 flex-shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3.5 w-28" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full bg-foreground/10" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading watch history…</span>
    </div>
  );
}
