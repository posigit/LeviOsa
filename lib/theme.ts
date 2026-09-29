/**
 * Single source of truth for the appearance theme (AMOLED / Soft dark / Light)
 * and the accent axis (Yellow / Beige) - independent axes, same plumbing.
 *
 * Ownership:
 * - First paint: app/layout.tsx inline script (reads localStorage pre-hydration).
 * - Runtime: applyTheme()/applyAccent() below - dataset + .dark class + localStorage + meta.
 * - React: useTheme()/useAccent() via useSyncExternalStore - never flashes a wrong segment,
 *   no per-component storage listeners, no mount-correction effect.
 */

import { useSyncExternalStore } from "react";

export type ThemeId = "amoled" | "soft" | "light";

export const THEMES: readonly ThemeId[] = ["amoled", "soft", "light"];

/**
 * Themes listed in the UI. Light stays valid (stored prefs, tokens, meta)
 * but is hidden until it gets a proper pass — AMOLED + Soft dark only.
 */
export const VISIBLE_THEMES: readonly ThemeId[] = ["amoled", "soft"];

export const THEME_META_COLOR: Record<ThemeId, string> = {
  amoled: "#000000",
  soft: "#101014",
  light: "#f4f4f6",
};

export const STORAGE_KEY = "tv-theme";
const CHANGE_EVENT = "tv-theme-change";

export function isThemeId(v: unknown): v is ThemeId {
  return v === "amoled" || v === "soft" || v === "light";
}

/** Saved theme, safe to call during SSR (defaults to AMOLED). */
export function getSavedTheme(): ThemeId {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") {
      return "amoled";
    }
    const t = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(t)) return t;
  } catch {
    /* ignore */
  }
  return "amoled";
}

/** Currently applied theme (reads the DOM — the layout script owns first paint). */
export function getCurrentTheme(): ThemeId {
  try {
    if (typeof document !== "undefined") {
      const t = document.documentElement.dataset.theme;
      if (isThemeId(t)) return t;
    }
  } catch {
    /* ignore */
  }
  return getSavedTheme();
}

/** Apply everywhere: dataset, .dark class (dark: utilities), meta, storage. */
export function applyTheme(theme: ThemeId): void {
  try {
    document.documentElement.dataset.theme = theme;
    // Keep the Tailwind `dark:` variant live: dark in amoled/soft, off in light.
    document.documentElement.classList.toggle("dark", theme !== "light");
  } catch {
    /* non-DOM environment */
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_META_COLOR[theme]);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent<ThemeId>(CHANGE_EVENT, { detail: theme }));
  } catch {
    /* ignore */
  }
}

/** Subscribe to same-tab applies + cross-tab storage sync. */
export function subscribeTheme(cb: (t: ThemeId) => void): () => void {
  const onCustom = (e: Event) => {
    const t = (e as CustomEvent<ThemeId>).detail;
    if (isThemeId(t)) cb(t);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY && isThemeId(e.newValue)) cb(e.newValue);
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

function getServerTheme(): ThemeId {
  return "amoled";
}

/** Live theme for components — SSR-safe, flash-free, listener-free. */
export function useTheme(): ThemeId {
  return useSyncExternalStore(subscribeTheme, getCurrentTheme, getServerTheme);
}

// ---------- accent axis (Yellow / Beige) ----------
// Orthogonal to the appearance theme: stored separately, dataset.accent.

export type AccentId = "yellow" | "beige";

export const ACCENTS: readonly AccentId[] = ["yellow", "beige"];

export const ACCENT_STORAGE_KEY = "tv-accent";
const ACCENT_CHANGE_EVENT = "tv-accent-change";

export function isAccentId(v: unknown): v is AccentId {
  return v === "yellow" || v === "beige";
}

/** Saved accent, safe to call during SSR (defaults to Yellow). */
export function getSavedAccent(): AccentId {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") {
      return "yellow";
    }
    const a = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isAccentId(a)) return a;
  } catch {
    /* ignore */
  }
  return "yellow";
}

/** Currently applied accent (reads the DOM - the layout script owns first paint). */
export function getCurrentAccent(): AccentId {
  try {
    if (typeof document !== "undefined") {
      const a = document.documentElement.dataset.accent;
      if (isAccentId(a)) return a;
    }
  } catch {
    /* ignore */
  }
  return getSavedAccent();
}

/** Apply everywhere: dataset + storage. */
export function applyAccent(accent: AccentId): void {
  try {
    document.documentElement.dataset.accent = accent;
  } catch {
    /* non-DOM environment */
  }
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent<AccentId>(ACCENT_CHANGE_EVENT, { detail: accent }));
  } catch {
    /* ignore */
  }
}

/** Subscribe to same-tab applies + cross-tab storage sync. */
export function subscribeAccent(cb: (a: AccentId) => void): () => void {
  const onCustom = (e: Event) => {
    const a = (e as CustomEvent<AccentId>).detail;
    if (isAccentId(a)) cb(a);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === ACCENT_STORAGE_KEY && isAccentId(e.newValue)) cb(e.newValue);
  };
  window.addEventListener(ACCENT_CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ACCENT_CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** Live accent for components — SSR-safe, flash-free, listener-free. */
export function useAccent(): AccentId {
  return useSyncExternalStore(
    subscribeAccent,
    getCurrentAccent,
    () => "yellow" satisfies AccentId
  );
}
