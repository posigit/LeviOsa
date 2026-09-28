import Link from "next/link";
import Image from "next/image";
import { ChevronRight, Star } from "lucide-react";

export type PersonCredit = {
  href: string;
  poster: string | null;
  title: string;
  /** Role the person played / the job they did */
  character?: string | null;
  year?: string | null;
  episodeCount?: number | null;
};

/** Big "11 / 147 — Seen" stat card. */
export function SeenStatCard({ seen, total }: { seen: number; total: number }) {
  if (total <= 0) return null;
  return (
    <section className="px-4 pt-6">
      <div className="rounded-2xl bg-card px-5 py-4">
        <p className="text-[32px] font-extrabold leading-none tracking-tight text-white tabular-nums">
          {seen} <span className="text-white/35">/</span> {total}
        </p>
        <p className="mt-2 text-sm text-white/50">Seen</p>
      </div>
    </section>
  );
}

/** Full-width horizontal poster rail — no caption, per the poster-first design. */
export function CreditRail({ items }: { items: PersonCredit[] }) {
  if (items.length === 0) return null;
  return (
    <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((c) => (
        <Link
          key={c.href + c.title}
          href={c.href}
          className="relative block w-[7.25rem] flex-shrink-0 overflow-hidden rounded-lg bg-card ring-1 ring-white/10"
          style={{ aspectRatio: "2 / 3" }}
        >
          {c.poster ? (
            <Image
              src={c.poster}
              alt={c.title}
              fill
              sizes="116px"
              className="object-cover"
              unoptimized
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center p-2 text-center text-xs font-bold text-white/50">
              {c.title}
            </span>
          )}
          <span className="sr-only">{c.title}</span>
        </Link>
      ))}
    </div>
  );
}

/** Poster + title + role + year row with a chevron — used by Coming Soon and
 *  the full filmography page. */
export function CreditRow({ credit }: { credit: PersonCredit }) {
  const meta =
    credit.year ||
    (credit.episodeCount != null
      ? `${credit.episodeCount} episode${credit.episodeCount === 1 ? "" : "s"}`
      : null);

  return (
    <Link href={credit.href} className="flex items-center gap-3 py-2">
      <div className="relative h-[5.5rem] w-14 flex-shrink-0 overflow-hidden rounded-md bg-card ring-1 ring-white/10">
        {credit.poster ? (
          <Image
            src={credit.poster}
            alt=""
            fill
            sizes="56px"
            className="object-cover"
            unoptimized
          />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-[17px] font-semibold leading-tight text-white">
          {credit.title}
        </p>
        {credit.character ? (
          <p className="mt-1 truncate text-[15px] text-white/50">
            {credit.character}
          </p>
        ) : null}
        {meta ? (
          <p className="mt-0.5 text-[15px] text-white/50">
            {credit.year && credit.episodeCount != null
              ? `${credit.year} · ${credit.episodeCount} episode${credit.episodeCount === 1 ? "" : "s"}`
              : meta}
          </p>
        ) : null}
      </div>

      <ChevronRight className="h-4 w-4 shrink-0 text-white/30" />
    </Link>
  );
}

/** Star rating shown on the person hero's credit chips. */
export function CreditScore({ value }: { value?: number }) {
  const text = value == null || value <= 0 ? "–" : value.toFixed(1);
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-white/60">
      <Star className="h-3 w-3 fill-primary text-primary" />
      {text}
    </span>
  );
}
