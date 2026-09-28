import { Skeleton } from "@/components/skeletons";

export default function LoginLoading() {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-6 pt-safe pb-safe"
      role="status"
      aria-label="Loading sign in"
    >
      <div className="w-full max-w-sm space-y-6">
        <Skeleton className="mx-auto h-9 w-40" />
        <div className="space-y-4">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl bg-foreground/15" />
        </div>
      </div>
      <span className="sr-only">Loading sign in…</span>
    </div>
  );
}
