"use client";

import { useState } from "react";

const CLAMP_CHARS = 380;

/**
 * Biography with a "More" toggle. TMDB bios run to several hundred words, so a
 * hard line-clamp leaves the reader on a half-finished sentence — this shows
 * the first screenful and expands to the full text in place.
 */
export function PersonBiography({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const clamped = text.trim().replace(/\r\n/g, "\n");
  const needsToggle = clamped.length > CLAMP_CHARS;
  const showClamp = needsToggle && !expanded;

  return (
    <section className="px-4 pt-7">
      <h2 className="mb-2 text-[22px] font-extrabold tracking-tight text-white">
        Biography
      </h2>
      <p
        className={`whitespace-pre-line text-sm leading-relaxed text-white/75 ${
          showClamp ? "line-clamp-6" : ""
        }`}
      >
        {clamped}
      </p>
      {needsToggle ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 text-sm font-bold text-primary transition active:scale-95"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </section>
  );
}
