"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type State = "loading" | "unsupported" | "denied" | "on" | "off";
type UnsupportedReason = "config" | "browser" | "ios-install";

function isIosDevice() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneMode() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Opt in/out of new-episode push alerts on this device.
 * Subscription rows live server-side; the daily cron does the sending.
 */
export function NotificationToggle() {
  const [state, setState] = useState<State>("loading");
  const [unsupportedReason, setUnsupportedReason] =
    useState<UnsupportedReason>("browser");
  const [busy, setBusy] = useState(false);
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!vapidKey) {
        if (!cancelled) {
          setUnsupportedReason("config");
          setState("unsupported");
        }
        return;
      }
      if (
        (isIosDevice() && !isStandaloneMode()) ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        if (!cancelled) {
          setUnsupportedReason(
            isIosDevice() && !isStandaloneMode() ? "ios-install" : "browser"
          );
          setState("unsupported");
        }
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setState("denied");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        const sub = await reg?.pushManager.getSubscription();
        if (!cancelled) setState(sub ? "on" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidKey]);

  async function enable() {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const reg =
        (await navigator.serviceWorker.getRegistration("/sw.js")) ??
        (await navigator.serviceWorker.register("/sw.js"));
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey!) as BufferSource,
      });
      const json = sub.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        }),
      });
      if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
      setState("on");
    } catch (err) {
      console.error("Enable notifications failed:", err);
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  if (state === "unsupported") {
    const message =
      unsupportedReason === "ios-install"
        ? "Add LeviOsa to your Home Screen to enable alerts"
        : unsupportedReason === "config"
          ? "Alerts are not configured on this deployment"
          : "Push alerts are not supported in this browser";
    return (
      <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground/50">
          <BellOff className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Episode alerts</p>
          <p className="text-xs text-muted-foreground">{message}</p>
        </div>
      </div>
    );
  }

  const on = state === "on";

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            on ? "bg-primary/15 text-primary" : "bg-secondary text-foreground/50"
          )}
        >
          {on ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Episode alerts</p>
          <p className="truncate text-xs text-muted-foreground">
            {state === "denied"
              ? "Blocked — allow notifications in browser settings"
              : on
                ? "On for this device"
                : "Get a push when a new episode airs"}
          </p>
        </div>
      </div>
      {state !== "denied" && (
        <button
          type="button"
          disabled={busy || state === "loading"}
          onClick={on ? disable : enable}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-xs font-black uppercase tracking-wide transition active:scale-95 disabled:opacity-40",
            on ? "bg-secondary text-foreground" : "bg-primary text-black"
          )}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {on ? "Turn off" : "Turn on"}
        </button>
      )}
    </div>
  );
}
