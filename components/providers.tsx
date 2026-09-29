"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { ReactNode, useEffect } from "react";
import { ToastProvider } from "@/components/toast";
import { hydrateVixSettings } from "@/lib/vix-settings";
import { initPlaybackOutbox } from "@/lib/offline/store";
import { initDownloadAutoRetry } from "@/lib/offline/engine";
import {
  applyAccent,
  applyTheme,
  getSavedAccent,
  getSavedTheme,
  subscribeAccent,
  subscribeTheme,
} from "@/lib/theme";

/** Hydrates player settings once the session is known (per-user data). */
function SettingsHydrator() {
  const { status } = useSession();
  useEffect(() => {
    if (status === "authenticated") void hydrateVixSettings();
  }, [status]);
  return null;
}

/** Re-asserts the saved appearance theme + accent on mount + across tabs. */
function ThemeHydrator() {
  useEffect(() => {
    // Layout script owns first paint; re-assert here for late mounts and
    // route the single cross-tab / same-tab subscription through applyTheme
    // (dataset + .dark class + theme-color stay in sync). Stored "light"
    // migrates to soft (unlisted - see VISIBLE_THEMES). Accent is an
    // independent axis (tv-accent) with the same plumbing.
    const saved = getSavedTheme();
    applyTheme(saved === "light" ? "soft" : saved);
    applyAccent(getSavedAccent());
    const unsubTheme = subscribeTheme(applyTheme);
    const unsubAccent = subscribeAccent(applyAccent);
    return () => {
      unsubTheme();
      unsubAccent();
    };
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Replay offline playback saves when connectivity returns.
    initPlaybackOutbox();
    // Resume downloads interrupted by connectivity loss.
    initDownloadAutoRetry();
    if (!("serviceWorker" in navigator)) return;
    // Production: full offline shell. Dev (?dev=1): /api/dl ONLY, so
    // offline-download playback works in dev without the worker touching
    // HMR, navigations or build chunks (see DEV_MODE in public/sw.js).
    const swUrl =
      process.env.NODE_ENV === "production" ? "/sw.js" : "/sw.js?dev=1";

    let cancelled = false;
    let reg: ServiceWorkerRegistration | null = null;

    const onVisible = () => {
      if (document.visibilityState !== "visible" || !reg) return;
      reg.update().catch(() => {});
      // The offline /library shell only refreshes on a full load of that
      // route; ping the worker so any foreground session keeps it current
      // with the running build (see the revalidate-shell message in sw.js).
      if (navigator.onLine) {
        navigator.serviceWorker.controller?.postMessage({
          type: "revalidate-shell",
        });
      }
    };

      navigator.serviceWorker
        .register(swUrl, {
          // Always revalidate sw.js (server also sends no-cache headers)
          updateViaCache: "none",
        })
      .then((registration) => {
        if (cancelled) return;
        reg = registration;
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <SessionProvider
      // Avoid spamming GET /api/auth/session on every focus/nav
      refetchOnWindowFocus={false}
      refetchWhenOffline={false}
      refetchInterval={0}
    >
      <SettingsHydrator />
      <ThemeHydrator />
      <ToastProvider>{children}</ToastProvider>
    </SessionProvider>
  );
}
