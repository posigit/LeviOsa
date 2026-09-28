"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionLabel } from "@/components/section-label";
import { DiscoverRail } from "@/components/discover-rail";
import { PosterRailSkeleton } from "@/components/skeletons";
import type { TmdbMediaCard } from "@/lib/tmdb";
import type { GenreChipMeta } from "@/lib/explore-types";
import { cn } from "@/lib/utils";

export function DiscoverGenreBrowser({ genres }: { genres: GenreChipMeta[] }) {
  const defaultKey = genres[0]?.key ?? "";
  const [active, setActive] = useState(defaultKey);
  const [itemsByKey, setItemsByKey] = useState<Record<string, TmdbMediaCard[]>>(
    {}
  );

  const selected = useMemo(
    () => genres.find((g) => g.key === active) ?? genres[0],
    [genres, active]
  );

  const selectedKey = selected?.key ?? "";
  const cached = selectedKey ? itemsByKey[selectedKey] : undefined;
  const loading = Boolean(selected) && cached === undefined;

  useEffect(() => {
    if (!selected) return;
    const key = selected.key;
    if (Object.prototype.hasOwnProperty.call(itemsByKey, key)) return;

    const ctrl = new AbortController();
    const kind = selected.kind;
    const genreId = selected.genreId;
    fetch(`/api/discover/genre?kind=${kind}&id=${genreId}`, {
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data: { items?: TmdbMediaCard[] }) => {
        const items = Array.isArray(data.items) ? data.items : [];
        setItemsByKey((prev) =>
          Object.prototype.hasOwnProperty.call(prev, key)
            ? prev
            : { ...prev, [key]: items }
        );
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setItemsByKey((prev) =>
          Object.prototype.hasOwnProperty.call(prev, key)
            ? prev
            : { ...prev, [key]: [] }
        );
      });
    return () => ctrl.abort();
  }, [selected, itemsByKey]);

  if (genres.length === 0) return null;

  const items = cached ?? [];

  return (
    <section className="mb-6">
      <div className="mb-3">
        <SectionLabel>Browse by genre</SectionLabel>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {genres.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setActive(g.key)}
            className={cn(
              "flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors active:scale-95",
              active === g.key
                ? "bg-primary text-black"
                : "bg-card text-white/80 hover:bg-white/10"
            )}
          >
            {g.label}
          </button>
        ))}
      </div>

      {selected && (
        <div className="mt-4">
          {loading ? (
            <PosterRailSkeleton count={5} />
          ) : items.length > 0 ? (
            <DiscoverRail
              heading="pill"
              label={
                selected.kind === "tv"
                  ? `${selected.label.replace(/^TV · /, "")} shows`
                  : `${selected.label.replace(/^Film · /, "")} movies`
              }
              items={items}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing new in this genre (or everything is already in your
              library).
            </p>
          )}
        </div>
      )}
    </section>
  );
}
