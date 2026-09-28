import Link from "next/link";
import { ArrowLeft, Wifi } from "lucide-react";
import { Skeleton } from "@/components/skeletons";
import { StickyChrome } from "@/components/sticky-chrome";

export default function LibraryLoading() {
  return (
    <div
      className="mx-auto min-h-dvh w-full max-w-2xl pb-28"
      role="status"
      aria-label="Loading library"
    >
      <StickyChrome contentClassName="px-4 pt-3 pb-2">
        <div className="flex items-center gap-3">
          <Link
            href="/profile"
            aria-label="Back to profile"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white ring-1 ring-white/10"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 ring-1 ring-white/10">
            <Wifi className="h-3.5 w-3.5 text-white/40" />
            <Skeleton className="h-3 w-12" />
          </span>
        </div>
      </StickyChrome>

      <div className="space-y-6 px-4 pt-4">
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
        </section>

        <div className="flex gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full" />
          ))}
        </div>

        <div className="space-y-5">
          <Skeleton className="h-3.5 w-24" />
          <div className="grid grid-cols-3 gap-x-2.5 gap-y-4">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="aspect-[2/3] w-full rounded-xl" />
                <Skeleton className="h-2.5 w-4/5" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <span className="sr-only">Loading library…</span>
    </div>
  );
}
