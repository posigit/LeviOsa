"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { Download, History, MoreHorizontal, CalendarDays } from "lucide-react";
import { DownloadSettingsSheet } from "@/components/download-settings-sheet";
import { InstallButton } from "@/components/install-button";
import { AccentToggle, ThemeToggle } from "@/components/theme-toggle";

/** Profile "⋯" menu: Watch history, Import data + Sign out */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-10 items-center justify-center rounded-full text-foreground"
        aria-label="More"
      >
        <MoreHorizontal className="h-6 w-6" />
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-30 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
          <Link
            href="/profile/history"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
          >
            <History className="h-4 w-4" />
            Watch history
          </Link>
          <Link
            href="/import"
            onClick={() => setOpen(false)}
            className="block w-full px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
          >
            Import data
          </Link>
          <Link
            href="/calendar?back=/profile"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
          >
            <CalendarDays className="h-4 w-4" />
            Calendar
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setDownloadsOpen(true);
            }}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
          >
            <Download className="h-4 w-4" />
            Library
          </button>
          <InstallButton />
          <div className="border-t border-border px-2 py-3">
            <p className="mb-2 px-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Appearance
            </p>
            <ThemeToggle layout="stacked" />
            <p className="mb-2 mt-3 px-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Accent
            </p>
            <AccentToggle />
          </div>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-secondary"
          >
            Sign out
          </button>
        </div>
      )}
      <DownloadSettingsSheet
        open={downloadsOpen}
        onClose={() => setDownloadsOpen(false)}
      />
    </div>
  );
}
