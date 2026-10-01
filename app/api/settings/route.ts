import { auth } from "@/lib/auth";
import { db, withDbRetry } from "@/lib/db";
import { userSettings } from "@/lib/schema";
import {
  DEFAULT_VIX_SETTINGS,
  isBannedSubLang,
  type VixSettings,
} from "@/lib/vix-settings";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Server-side player settings (source of truth across devices).
 *
 * GET  → { settings: VixSettings | null }   (null = never synced)
 * POST → upsert the settings blob
 *
 * Normalization mirrors lib/vix-settings.ts: defaults merge + banned-language
 * clamp (Italian must never persist). Values are validated loosely on purpose —
 * the schema is a JSONB blob and the client is the only writer.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const row = await withDbRetry(() =>
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, session.user.id),
    })
  );
  return NextResponse.json({ settings: row?.settings ?? null });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("settings" in body)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const incoming = (body as { settings: Partial<VixSettings> }).settings ?? {};
  if (typeof incoming !== "object" || incoming === null) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }

  // Normalize exactly like the client: merge defaults, clamp banned langs.
  // muted is session-only — never persist true (autoplay/PWA re-poison).
  const merged: VixSettings = {
    ...DEFAULT_VIX_SETTINGS,
    ...incoming,
    muted: false,
    v: DEFAULT_VIX_SETTINGS.v,
  };
  if (typeof merged.subs !== "string") merged.subs = DEFAULT_VIX_SETTINGS.subs;
  if (typeof merged.audio !== "string") merged.audio = DEFAULT_VIX_SETTINGS.audio;
  if (
    merged.subBgBlur !== "none" &&
    merged.subBgBlur !== "sm" &&
    merged.subBgBlur !== "md" &&
    merged.subBgBlur !== "lg"
  ) {
    merged.subBgBlur = DEFAULT_VIX_SETTINGS.subBgBlur;
  }
  if (
    merged.videoFit !== "fit" &&
    merged.videoFit !== "cover" &&
    merged.videoFit !== "stretch"
  ) {
    merged.videoFit = DEFAULT_VIX_SETTINGS.videoFit;
  }
  if (
    merged.embedZoom !== 1 &&
    merged.embedZoom !== 1.25 &&
    merged.embedZoom !== 1.5
  ) {
    merged.embedZoom = DEFAULT_VIX_SETTINGS.embedZoom;
  }
  if (isBannedSubLang(merged.subs)) merged.subs = "en";
  if (isBannedSubLang(merged.audio)) merged.audio = "en";
  // Offline-download prefs (client-clamped; re-clamp defensively).
  merged.downloadMode = merged.downloadMode === true;
  if (
    merged.downloadQuality !== 480 &&
    merged.downloadQuality !== 720 &&
    merged.downloadQuality !== 1080 &&
    merged.downloadQuality !== "best"
  ) {
    merged.downloadQuality = DEFAULT_VIX_SETTINGS.downloadQuality;
  }
  if (
    typeof merged.downloadCapMb !== "number" ||
    !Number.isFinite(merged.downloadCapMb)
  ) {
    merged.downloadCapMb = DEFAULT_VIX_SETTINGS.downloadCapMb;
  } else {
    merged.downloadCapMb = Math.max(
      100,
      Math.min(32_000, merged.downloadCapMb)
    );
  }

  // Transient DB failures (Railway cold start, dropped pool connections)
  // retry instead of 500ing the whole settings sync.
  await withDbRetry(() =>
    db
      .insert(userSettings)
      .values({
        userId: session.user.id,
        settings: merged as unknown as object,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          settings: merged as unknown as object,
          updatedAt: new Date(),
        },
      })
  );

  return NextResponse.json({ success: true, settings: merged });
}