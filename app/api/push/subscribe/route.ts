import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pushSubscriptions } from "@/lib/schema";
import { eq } from "drizzle-orm";

/**
 * POST /api/push/subscribe — save a PushSubscription for the signed-in user.
 * DELETE /api/push/subscribe — remove it (opt out on this device).
 */
export async function POST(request: Request) {
  const userId = await requireAuth();

  let body: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const endpoint = body.endpoint?.trim();
  const p256dh = body.keys?.p256dh?.trim();
  const auth = body.keys?.auth?.trim();
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json(
      { ok: false, error: "endpoint, keys.p256dh and keys.auth are required" },
      { status: 400 }
    );
  }

  await db
    .insert(pushSubscriptions)
    .values({ endpoint, userId, p256dh, auth })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh, auth },
    });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  await requireAuth();

  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const endpoint = body.endpoint?.trim();
  if (!endpoint) {
    return NextResponse.json(
      { ok: false, error: "endpoint is required" },
      { status: 400 }
    );
  }

  await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));

  return NextResponse.json({ ok: true });
}
