import { Skeleton } from "@/components/skeletons";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export default function CalendarLoading() {
  return (
    <div
      className="min-h-dvh bg-background px-4 pb-nav-page"
      role="status"
      aria-label="Loading calendar"
    >
      <div className="sticky-chrome-crisp sticky top-0 z-40 -mx-4 bg-background/85 px-4 pb-2 pt-safe-float backdrop-blur">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-5 w-32" />
          <div className="h-9 w-9" />
        </div>
      </div>

      <div className="mt-4">
        {/* Month label + prev/next arrows */}
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-9 w-9 rounded-full bg-secondary" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-9 rounded-full bg-secondary" />
        </div>

        {/* Weekday header */}
        <div className="mb-1 grid grid-cols-7 gap-1">
          {WEEKDAYS.map((d, i) => (
            <p
              key={i}
              className="text-center text-[10px] font-bold uppercase tracking-wider text-foreground/30"
            >
              {d}
            </p>
          ))}
        </div>

        {/* 6-row / 42-cell month grid */}
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 42 }, (_, i) => (
            <Skeleton key={i} className="aspect-[0.72] w-full rounded-lg" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading calendar…</span>
    </div>
  );
}
