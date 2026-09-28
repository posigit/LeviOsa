import { Skeleton } from "@/components/skeletons";

export default function LibraryLoading() {
  return (
    <div
      className="mx-auto min-h-dvh w-full max-w-2xl px-4 pb-28 pt-[max(1rem,env(safe-area-inset-top))]"
      role="status"
      aria-label="Loading library"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="min-w-0 space-y-1.5">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
      <span className="sr-only">Loading library…</span>
    </div>
  );
}
