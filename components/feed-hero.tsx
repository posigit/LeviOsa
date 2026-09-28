"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Play, Star } from "lucide-react";
import { backdropUrl, posterUrl, type TmdbMediaCard } from "@/lib/tmdb";

const SLIDE_MS = 6500;

function slideImage(item: TmdbMediaCard) {
  if (item.backdrop_path) return backdropUrl(item.backdrop_path, "original");
  if (item.poster_path) return posterUrl(item.poster_path, "w780");
  return null;
}

function slideHref(item: TmdbMediaCard) {
  return item.mediaType === "tv" ? `/show/${item.id}` : `/movie/${item.id}`;
}

/** Featured carousel that opens Explore: one full-bleed backdrop at a time,
 *  crossfading on a timer, with a plain CTA pill over the bottom scrim. */
export function FeedHero({
  items,
  kicker = "Featured",
}: {
  items: TmdbMediaCard[];
  kicker?: string;
}) {
  const slides = items.filter((item) => item.title);
  const count = slides.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const active = slides[index] ?? slides[0];

  useEffect(() => {
    if (count < 2 || paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(
      () => setIndex((value) => (value + 1) % count),
      SLIDE_MS
    );
    return () => clearInterval(timer);
  }, [count, paused, index]);

  if (!active) return null;

  const go = (next: number) => setIndex((next + count) % count);

  return (
    <section
      aria-label={kicker}
      className="relative isolate -mx-4 mb-6 h-[46dvh] max-h-[440px] min-h-[300px] overflow-hidden bg-black"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {slides.map((item, i) => {
        const src = slideImage(item);
        return (
          <div
            key={`${item.mediaType}-${item.id}`}
            aria-hidden={i !== index}
            className={`absolute inset-0 transition-opacity duration-700 ${
              i === index ? "opacity-100" : "opacity-0"
            }`}
          >
            {src ? (
              <Image
                src={src}
                alt=""
                fill
                priority={i === 0}
                sizes="100vw"
                className="object-cover"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-secondary via-black to-black" />
            )}
          </div>
        );
      })}

      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 60% at 50% 100%, rgb(var(--theme) / 0.3), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/70 to-transparent"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[70%]"
        style={{
          background:
            "linear-gradient(to top, #000 12%, rgb(0 0 0 / 0.86) 34%, rgb(0 0 0 / 0.46) 64%, transparent)",
        }}
      />

      <div className="absolute inset-x-0 bottom-0 px-5 pb-5">
        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-primary">
          {kicker}
        </p>
        <h2 className="mt-1.5 text-[26px] font-black leading-tight tracking-tight text-white drop-shadow-[0_3px_14px_rgba(0,0,0,0.9)]">
          {active.title}
        </h2>

        <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-semibold text-white/70">
          <span className="rounded-full border border-white/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white/85">
            {active.mediaType === "tv" ? "Series" : "Film"}
          </span>
          {active.vote_average ? (
            <span className="inline-flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-primary text-primary" />
              {active.vote_average.toFixed(1)}
            </span>
          ) : null}
          {active.badge ? <span className="text-white/55">{active.badge}</span> : null}
        </p>

        {active.overview ? (
          <p className="mt-2 line-clamp-2 max-w-xl text-[13px] leading-snug text-white/60">
            {active.overview}
          </p>
        ) : null}

        <div className="mt-3.5 flex items-center gap-2">
          <Link
            href={slideHref(active)}
            className="glass-control inline-flex h-11 items-center gap-2 rounded-full bg-white/10 px-5 text-sm font-bold text-white transition hover:bg-white/25 active:scale-95"
          >
            <Play className="h-4 w-4 fill-white" />
            More info
          </Link>

          {count > 1 && (
            <div
              className="ml-auto flex items-center gap-1.5"
              role="tablist"
              aria-label="Featured slides"
            >
              {slides.map((item, i) => (
                <button
                  key={`dot-${item.mediaType}-${item.id}`}
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`Slide ${i + 1}`}
                  onClick={() => setIndex(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === index ? "w-6 bg-white" : "w-1.5 bg-white/40 hover:bg-white/70"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {count > 1 && (
        <>
          <button
            onClick={() => go(index - 1)}
            aria-label="Previous"
            className="glass-control absolute left-2 top-1/2 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 active:scale-95 sm:grid"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={() => go(index + 1)}
            aria-label="Next"
            className="glass-control absolute right-2 top-1/2 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 active:scale-95 sm:grid"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      )}
    </section>
  );
}
