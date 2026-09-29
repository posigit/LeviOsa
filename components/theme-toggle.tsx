"use client";

import { useCallback } from "react";
import { Contrast, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  VISIBLE_THEMES,
  applyAccent,
  applyTheme,
  useAccent,
  useTheme,
  type AccentId,
  type ThemeId,
} from "@/lib/theme";

export type { ThemeId };

const OPTIONS: Array<{
  id: ThemeId;
  label: string;
  blurb: string;
  swatch: string;
  Icon: typeof Moon;
}> = [
  {
    id: "amoled",
    label: "AMOLED",
    blurb: "Pure black",
    swatch: "#000000",
    Icon: Moon,
  },
  {
    id: "soft",
    label: "Soft dark",
    blurb: "Dimmed charcoal",
    swatch: "#1a1a20",
    Icon: Contrast,
  },
  {
    id: "light",
    label: "Light",
    blurb: "Bright",
    swatch: "#f4f4f6",
    Icon: Sun,
  },
];

/** Segmented AMOLED / Soft dark switch (Light hidden — see VISIBLE_THEMES). */
export function ThemeToggle({
  compact = false,
  layout = "segmented",
  options = VISIBLE_THEMES,
}: {
  compact?: boolean;
  /** "stacked" = full-width rows with preview swatches (profile menu). */
  layout?: "segmented" | "stacked";
  /** Listed themes — defaults to the visible set (Light stays stored-valid). */
  options?: readonly ThemeId[];
}) {
  // Live theme from the DOM (layout script owns first paint) — no mount
  // correction, no flash of the wrong segment.
  const theme = useTheme();
  const listed = OPTIONS.filter((o) => options.includes(o.id));

  const pick = useCallback((id: ThemeId) => {
    applyTheme(id);
    try {
      navigator.vibrate?.(8);
    } catch {
      /* ignore */
    }
  }, []);

  if (layout === "stacked") {
    return (
      <div role="radiogroup" aria-label="Appearance" className="flex flex-col gap-1">
        {listed.map(({ id, label, blurb, swatch, Icon }) => {
          const active = theme === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(id)}
              className={cn(
                "flex min-h-[48px] w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition active:scale-[0.99]",
                active
                  ? "bg-primary text-black"
                  : "text-foreground hover:bg-secondary"
              )}
            >
              <span
                aria-hidden="true"
                className="h-6 w-6 flex-shrink-0 rounded-full ring-1 ring-inset ring-black/20"
                style={{ backgroundColor: swatch }}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold leading-tight">
                  {label}
                </span>
                <span
                  className={cn(
                    "block text-[11px] leading-tight",
                    active ? "text-black/70" : "text-muted-foreground"
                  )}
                >
                  {blurb}
                </span>
              </span>
              {active ? (
                <span aria-hidden="true" className="text-base font-black leading-none">
                  ✓
                </span>
              ) : (
                <Icon className="h-4 w-4 flex-shrink-0 opacity-60" strokeWidth={2.5} />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={cn(
        "flex items-center gap-1 rounded-full bg-secondary p-1",
        compact ? "" : "w-full"
      )}
    >
      {listed.map(({ id, label, Icon }) => {
        const active = theme === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => pick(id)}
            className={cn(
              "flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-2 text-[11px] font-bold transition active:scale-95 sm:min-h-0",
              active
                ? "bg-primary text-black shadow"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

const ACCENT_OPTIONS: Array<{ id: AccentId; label: string; blurb: string; swatch: string }> = [
  {
    id: "yellow",
    label: "Yellow",
    blurb: "Classic gold",
    swatch: "#f5c518",
  },
  {
    id: "beige",
    label: "Beige",
    blurb: "Soft cream",
    swatch: "#e9e5d2",
  },
];

/** Segmented Yellow / Beige accent switch (independent of the theme rows). */
export function AccentToggle({ compact = false }: { compact?: boolean }) {
  // Live accent from the DOM (layout script owns first paint) - same
  // no-mount-correction pattern as ThemeToggle.
  const accent = useAccent();

  const pick = useCallback((id: AccentId) => {
    applyAccent(id);
    try {
      navigator.vibrate?.(8);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label="Accent"
      className={cn(
        "flex items-center gap-1 rounded-full bg-secondary p-1",
        compact ? "" : "w-full"
      )}
    >
      {ACCENT_OPTIONS.map(({ id, label, blurb, swatch }) => {
        const active = accent === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={`${label} - ${blurb}`}
            onClick={() => pick(id)}
            className={cn(
              "flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-2 text-[11px] font-bold transition active:scale-[0.98]",
              active
                ? "bg-primary text-black shadow"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 flex-shrink-0 rounded-full ring-1 ring-inset ring-black/25"
              style={{ backgroundColor: swatch }}
            />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
