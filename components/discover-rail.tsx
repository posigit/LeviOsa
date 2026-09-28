import Link from "next/link";
import Image from "next/image";
import { posterUrl, type TmdbMediaCard } from "@/lib/tmdb";
import { SectionLabel } from "@/components/section-label";

export function DiscoverRail({
  label,
  items,
  heading = "title",
}: {
  label: string;
  items: TmdbMediaCard[];
  /**
   * `title` = the clean 22px bold heading used by Cast / Storyline /
   * Information on the detail pages. `pill` = the grey uppercase pill the
   * Explore feed uses for its own sections.
   */
  heading?: "title" | "pill";
}) {
  if (items.length === 0) return null;

  return (
    <section className="mb-6">
      {heading === "pill" ? (
        <div className="mb-3">
          <SectionLabel>{label}</SectionLabel>
        </div>
      ) : (
        <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
          {label}
        </h2>
      )}
      <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const href =
            item.mediaType === "tv"
              ? `/show/${item.id}`
              : `/movie/${item.id}`;

          return (
            <Link
              key={`${item.mediaType}-${item.id}`}
              href={href}
              className="relative block w-[7.25rem] flex-shrink-0 overflow-hidden rounded-lg bg-card"
              style={{ aspectRatio: "2 / 3" }}
            >
              {item.poster_path ? (
                <Image
                  src={posterUrl(item.poster_path, "w342") ?? ""}
                  alt={item.title}
                  fill
                  sizes="116px"
                  className="object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center p-2 text-center text-[10px] text-muted-foreground">
                  {item.title}
                </span>
              )}
              {item.badge && (
                <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/75 px-1.5 py-0.5 text-[8px] font-bold uppercase text-primary">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
