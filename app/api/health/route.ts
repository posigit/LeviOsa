import { NextResponse } from "next/server";
import { pingDb } from "@/lib/db";
import { getResolverBases, resolverEnvState } from "@/lib/resolver-env";

/**
 * Lightweight health + DB keep-alive endpoint.
 *
 * Point an external cron (cron-job.org, UptimeRobot, GitHub Actions)
 * at GET /api/health every 5–10 minutes to reduce Railway cold starts.
 *
 * Optional: set HEALTH_CRON_SECRET and call with
 *   Authorization: Bearer <secret>
 * or ?secret=<secret>
 */
export async function GET(request: Request) {
  const secret = process.env.HEALTH_CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    const url = new URL(request.url);
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const querySecret = url.searchParams.get("secret");
    if (bearer !== secret && querySecret !== secret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  const started = Date.now();
  // Integration presence (flags only, never values) so a dashboard can tell
  // "not configured" apart from "down" — e.g. OpenSubtitles 501s.
  // vixResolver is VALIDATED (a placeholder like "[SENSITIVE]" counts as
  // down, not configured); vixResolverState splits unset/valid/invalid.
  const vixState = resolverEnvState();
  const integrations = {
    tmdb: Boolean(
      process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY
    ),
    vixResolver: vixState === "valid",
    vixResolverState: vixState,
    openSubtitles:
      Boolean(process.env.OPENSUBTITLES_API_KEY) &&
      Boolean(process.env.OPENSUBTITLES_USERNAME) &&
      Boolean(process.env.OPENSUBTITLES_PASSWORD),
    subdl: Boolean(process.env.SUBDL_API_KEY),
    push:
      Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) &&
      Boolean(process.env.VAPID_PRIVATE_KEY),
  };

  // Liveness probes (all bounded, all parallel): env-validation alone can't
  // tell "configured" from "reachable". Failures degrade to "down", never 500.
  const probe = async (
    url: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; ms: number; status?: number }> => {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: res.ok, ms: Date.now() - t0, status: res.status };
    } catch {
      return { ok: false, ms: Date.now() - t0 };
    }
  };
  const resolverBases = getResolverBases();
  const tmdbKey =
    process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY;
  const [dbResult, resolverResult, tmdbResult] = await Promise.all([
    pingDb(5, 1000).then(
      (): { ok: boolean; error?: string } => ({ ok: true }),
      (err: unknown): { ok: boolean; error?: string } => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    ),
    resolverBases.length > 0
      ? probe(`${resolverBases[0]}/health`, 5_000)
      : Promise.resolve<{ ok: boolean; ms: number; status?: number } | null>(null),
    tmdbKey
      ? probe(
          `https://api.themoviedb.org/3/configuration?api_key=${tmdbKey}`,
          5_000
        )
      : Promise.resolve<{ ok: boolean; ms: number; status?: number } | null>(null),
  ]);
  const live = {
    db: dbResult.ok ? "up" : "down",
    vixResolver:
      resolverResult == null ? "unconfigured" : resolverResult.ok ? "up" : "down",
    tmdb: tmdbResult == null ? "unconfigured" : tmdbResult.ok ? "up" : "down",
  } as const;
  const latency = {
    db: Date.now() - started,
    ...(resolverResult ? { vixResolverMs: resolverResult.ms } : {}),
    ...(tmdbResult ? { tmdbMs: tmdbResult.ms } : {}),
  };
  const ok = dbResult.ok;
  return NextResponse.json(
    {
      ok,
      db: live.db,
      ...(dbResult.error ? { error: dbResult.error } : {}),
      ms: Date.now() - started,
      ts: new Date().toISOString(),
      integrations,
      live,
      latency,
    },
    { status: ok ? 200 : 503 }
  );
}
