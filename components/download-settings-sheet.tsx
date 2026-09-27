"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { DownloadLibraryList } from "@/components/download-row";
import {
  DEFAULT_VIX_SETTINGS,
  loadVixSettings,
  saveVixSettings,
} from "@/lib/vix-settings";
import {
  ensurePersisted,
  formatBytes,
  getAllSync,
  getManifest,
  storageStats,
  subscribeDownloads,
  touchRecord,
  verifyRecordFiles,
  type DownloadRecord,
} from "@/lib/downloads";

type Quality = 480 | 720 | 1080 | "best";

const QUALITY_OPTIONS: { value: Quality; label: string; hint: string }[] = [
  { value: 480, label: "480p", hint: "~350 MB / ep" },
  { value: 720, label: "720p", hint: "~800 MB / ep" },
  { value: 1080, label: "1080p", hint: "~1.5 GB+ / ep" },
  { value: "best", label: "Best", hint: "Biggest file" },
];

const CAP_OPTIONS = [
  { value: 500, label: "500 MB" },
  { value: 950, label: "950 MB" },
  { value: 2000, label: "2 GB" },
  { value: 5000, label: "5 GB" },
];

export function requestOfflinePlay(key: string) {
  window.dispatchEvent(
    new CustomEvent("tvtime:play-offline", { detail: { key } })
  );
}

/**
 * Download settings bottom sheet: mode toggle, quality + storage-cap
 * pickers, live storage meter, and the on-device library.
 */
export function DownloadSettingsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState(false);
  const [quality, setQuality] = useState<Quality>(720);
  const [capMb, setCapMb] = useState<number>(
    DEFAULT_VIX_SETTINGS.downloadCapMb
  );
  const [items, setItems] = useState<DownloadRecord[]>([]);
  const [quota, setQuota] = useState<number | undefined>();
  const [usage, setUsage] = useState<number | undefined>();
  // Portal target: rendering under document.body escapes ancestor stacking
  // contexts (profile page wrappers) so the sheet + backdrop always paint
  // above the bottom tab bar instead of sliding under it. `open` can only
  // become true from a client tap, so document is guaranteed here.

  const readSettings = useCallback(() => {
    try {
      const s = loadVixSettings();
      return {
        mode: s.downloadMode === true,
        quality: s.downloadQuality,
        capMb: s.downloadCapMb,
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // All state writes happen in async continuations (never sync in the
    // effect body) so open-time hydration doesn't cascade-render.
    void (async () => {
      const s = readSettings();
      if (!alive) return;
      if (s) {
        setMode(s.mode);
        setQuality(s.quality);
        setCapMb(s.capMb);
      }
      setItems(getAllSync());
      const st = await storageStats();
      if (!alive) return;
      setQuota(st.quota);
      setUsage(st.usage);
      // Flip stale `done` rows to `missing` when the OS evicted bytes.
      const m = await getManifest();
      if (!alive) return;
      await Promise.all(
        Object.values(m)
          .filter((r) => r.state === "done")
          .map((r) => verifyRecordFiles(r.key))
      );
      if (!alive) return;
      setItems(getAllSync());
    })();
    const unsub = subscribeDownloads(() => {
      setItems(getAllSync());
      void storageStats().then((st) => {
        setQuota(st.quota);
        setUsage(st.usage);
      });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      unsub();
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, readSettings]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const toggleMode = () => {
    const next = !mode;
    setMode(next);
    saveVixSettings({ downloadMode: next });
    if (next) void ensurePersisted();
    toast(next ? "Download mode on — look for ↓" : "Download mode off");
  };

  const pickQuality = (q: Quality) => {
    setQuality(q);
    saveVixSettings({ downloadQuality: q });
  };

  const pickCap = (mb: number) => {
    setCapMb(mb);
    saveVixSettings({ downloadCapMb: mb });
    toast(`Storage cap ${mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`}`);
  };

  const usedByApp = items
    .filter((r) => r.state === "done")
    .reduce((s, r) => s + r.sizeBytes, 0);
  const doneCount = items.filter((r) => r.state === "done").length;
  const capBytes = capMb * 1024 * 1024;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col">
      <button
        type="button"
        aria-label="Close download settings"
        className="absolute inset-0 bg-black/75 backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Download settings"
        className="relative mt-auto flex max-h-[93dvh] w-full flex-col rounded-t-[1.35rem] bg-card shadow-[0_-20px_60px_rgba(0,0,0,0.65)] ring-1 ring-border"
      >
        <div className="flex justify-center pb-1 pt-2.5">
          <div className="h-1 w-10 rounded-full bg-secondary" />
        </div>
        <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-1">
          <div>
            <h2 className="text-xl font-black tracking-tight text-foreground">
              Library
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-secondary text-foreground/70 transition hover:bg-secondary hover:text-foreground active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-safe-page">
          {/* Mode toggle */}
          <button
            type="button"
            onClick={toggleMode}
            aria-pressed={mode}
            className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-2xl bg-secondary px-4 py-4 ring-1 ring-border transition active:scale-[0.99]"
          >
            <span className="text-left">
              <span className="block text-[15px] font-bold text-foreground">
                Download mode
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "relative h-8 w-[3.25rem] shrink-0 rounded-full transition-colors",
                mode ? "bg-success" : "bg-secondary"
              )}
            >
              <span
                className={cn(
                  "absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all",
                  mode ? "left-6" : "left-1"
                )}
              />
            </span>
          </button>

          {/* Quality */}
          <div className="mt-5 flex items-baseline justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/40">
              Download quality
            </p>
            <p className="text-[11px] text-foreground/30">applies to new downloads</p>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {QUALITY_OPTIONS.map((q) => (
              <button
                key={String(q.value)}
                type="button"
                onClick={() => pickQuality(q.value)}
                aria-pressed={quality === q.value}
                className={cn(
                  "cursor-pointer rounded-2xl px-1 py-2.5 ring-1 transition active:scale-95",
                  quality === q.value
                    ? "bg-primary text-black ring-primary"
                    : "bg-secondary text-foreground/60 ring-border hover:text-foreground"
                )}
              >
                <span className="block text-sm font-black">{q.label}</span>
                <span
                  className={cn(
                    "mt-0.5 block text-[9px] font-semibold leading-tight",
                    quality === q.value ? "text-black/70" : "text-foreground/35"
                  )}
                >
                  {q.hint}
                </span>
              </button>
            ))}
          </div>

          {/* Storage cap */}
          <p className="mb-2 mt-5 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/40">
            Storage cap
          </p>
          <div className="grid grid-cols-4 gap-2">
            {CAP_OPTIONS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => pickCap(c.value)}
                aria-pressed={capMb === c.value}
                className={cn(
                  "cursor-pointer rounded-2xl px-1 py-2.5 text-sm font-black ring-1 transition active:scale-95",
                  capMb === c.value
                    ? "bg-primary text-black ring-primary"
                    : "bg-secondary text-foreground/60 ring-border hover:text-foreground"
                )}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* Storage meter */}
          <div className="mt-3 rounded-2xl bg-secondary px-4 py-3.5 ring-1 ring-border">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground">Storage</p>
                <p className="mt-0.5 truncate text-[11px] tabular-nums text-foreground/40">
                  {doneCount} · {formatBytes(capBytes)} cap
                </p>
              </div>
              <p className="shrink-0 text-right leading-none">
                <span className="block text-xl font-black text-foreground">
                  {formatBytes(usedByApp)}
                </span>
                <span className="mt-1 block text-[10px] font-bold uppercase tracking-wider text-foreground/35">
                  used
                </span>
              </p>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${Math.min(100, (usedByApp / capBytes) * 100)}%`,
                }}
              />
            </div>
            {usage != null && quota != null && (
              <p className="mt-2 text-[11px] font-semibold tabular-nums text-foreground/35">
                {formatBytes(quota - usage)} free on device
              </p>
            )}
          </div>

          {/* Library */}
          <p className="mb-2 mt-5 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/40">
            Library ({items.length})
          </p>
          {items.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                toast("Turn on download mode, then tap download on anything");
              }}
              className="w-full cursor-pointer rounded-2xl bg-secondary px-4 py-6 text-center ring-1 ring-border transition active:scale-[0.99]"
            >
              <Download className="mx-auto h-5 w-5 text-foreground/30" />
              <p className="mt-2 text-sm font-semibold text-foreground/50">
                No downloads yet
              </p>
            </button>
          ) : (
            <div className="space-y-2 pb-4">
              <DownloadLibraryList
                records={items}
                onPlay={(r) => {
                  onClose();
                  void touchRecord(r.key);
                  requestOfflinePlay(r.key);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

