import { auth } from "@/lib/auth";
import { db, withDbRetry } from "@/lib/db";
import { getAllPlaybackPositions } from "@/lib/playback";
import { playbackPositions } from "@/lib/schema";
import { eq, and, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

/**
 * Resume-playback positions.
 *   GET    /api/playback?type=movie|tv&id=<tmdbId>[&season=N&episode=N]
 *   GET    /api/playback?all=1  → { items: [...] } every bookmark for the user
 *   POST   ?type=...&id=... with { positionSeconds, durationSeconds }
 *   DELETE /api/playback?type=...&id=...
 * Movies use season/episode = 0 (defaults).
 */

const MAX_SECONDS = 2_147_483_647;

function parseNonNegativeInt(
  value: string | null,
  fallback: number
): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_SECONDS ? parsed : null;
}

function parseMediaParams(sp: URLSearchParams) {
  const type = sp.get("type"); // "movie" | "tv"
  const tmdbId = parseNonNegativeInt(sp.get("id"), 0);
  const seasonNumber = parseNonNegativeInt(sp.get("season"), 0);
  const episodeNumber = parseNonNegativeInt(sp.get("episode"), 0);
  if (
    (type !== "movie" && type !== "tv") ||
    tmdbId === null ||
    tmdbId === 0 ||
    seasonNumber === null ||
    episodeNumber === null
  ) {
    return null;
  }
  if (type === "tv" && (!sp.has("season") || !sp.has("episode"))) {
    return null;
  }
  return {
    type,
    tmdbId,
    seasonNumber: type === "movie" ? 0 : seasonNumber,
    episodeNumber: type === "movie" ? 0 : episodeNumber,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("all") === "1") {
    const items = await getAllPlaybackPositions(session.user.id);
    return NextResponse.json({ items });
  }
  const p = parseMediaParams(req.nextUrl.searchParams);
  if (!p) return NextResponse.json({ error: "Invalid params" }, { status: 400 });

  const [row] = await withDbRetry(() =>
    db
      .select({
        positionSeconds: playbackPositions.positionSeconds,
        durationSeconds: playbackPositions.durationSeconds,
      })
      .from(playbackPositions)
      .where(
        and(
          eq(playbackPositions.userId, session.user.id),
          eq(playbackPositions.mediaType, p.type),
          eq(playbackPositions.tmdbId, p.tmdbId),
          eq(playbackPositions.seasonNumber, p.seasonNumber),
          eq(playbackPositions.episodeNumber, p.episodeNumber)
        )
      )
      .limit(1)
  );

  if (!row) return NextResponse.json({ positionSeconds: 0 });
  return NextResponse.json(row);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Media identity comes from the query (same as GET/DELETE); the body only
  // carries position/duration.
  const p = parseMediaParams(req.nextUrl.searchParams);
  if (!p) return NextResponse.json({ error: "Invalid params" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = body as {
    positionSeconds?: unknown;
    durationSeconds?: unknown;
  };
  const positionSeconds = payload.positionSeconds;
  const durationSeconds =
    payload.durationSeconds === undefined ? 0 : payload.durationSeconds;

  if (
    typeof positionSeconds !== "number" ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0 ||
    positionSeconds > MAX_SECONDS ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0 ||
    durationSeconds > MAX_SECONDS
  ) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const normalizedDuration = Math.min(MAX_SECONDS, durationSeconds);
  const normalizedPosition = Math.min(
    positionSeconds,
    normalizedDuration > 0 ? normalizedDuration : MAX_SECONDS
  );

  await withDbRetry(() =>
    db
      .insert(playbackPositions)
      .values({
        userId: session.user.id,
        mediaType: p.type,
        tmdbId: p.tmdbId,
        seasonNumber: p.seasonNumber,
        episodeNumber: p.episodeNumber,
        positionSeconds: normalizedPosition,
        durationSeconds: normalizedDuration,
      })
      .onConflictDoUpdate({
        target: [
          playbackPositions.userId,
          playbackPositions.mediaType,
          playbackPositions.tmdbId,
          playbackPositions.seasonNumber,
          playbackPositions.episodeNumber,
        ],
        set: {
          // Do not let an update without duration move past a known bookmark
          // duration from an earlier player event.
          positionSeconds:
            normalizedDuration > 0
              ? normalizedPosition
              : sql`CASE WHEN ${playbackPositions.durationSeconds} > 0 THEN LEAST(${normalizedPosition}, ${playbackPositions.durationSeconds}) ELSE ${normalizedPosition} END`,
          // Keep a known duration when a player update cannot report one.
          durationSeconds:
            normalizedDuration > 0
              ? normalizedDuration
              : sql`${playbackPositions.durationSeconds}`,
          updatedAt: sql`now()`,
        },
      })
  );

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const p = parseMediaParams(req.nextUrl.searchParams);
  if (!p) return NextResponse.json({ error: "Invalid params" }, { status: 400 });

  await withDbRetry(() =>
    db
      .delete(playbackPositions)
      .where(
        and(
          eq(playbackPositions.userId, session.user.id),
          eq(playbackPositions.mediaType, p.type),
          eq(playbackPositions.tmdbId, p.tmdbId),
          eq(playbackPositions.seasonNumber, p.seasonNumber),
          eq(playbackPositions.episodeNumber, p.episodeNumber)
        )
      )
  );

  return NextResponse.json({ success: true });
}
