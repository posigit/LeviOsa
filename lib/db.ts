import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function resolveConnectionString(): string {
  try {
    const ctx = getCloudflareContext();
    const hd = (ctx.env as { HYPERDRIVE?: { connectionString?: string } }).HYPERDRIVE;
    if (hd?.connectionString) return hd.connectionString;
  } catch {
    // Outside the Worker runtime (next build SSG, tsx scripts, plain node)
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error(
    "No database connection string: HYPERDRIVE binding and DATABASE_URL are both missing"
  );
}

let poolInstance: Pool | null = null;

function createPool(): Pool {
  const p = new Pool({
    connectionString: resolveConnectionString(),
    // Enough for page load + a few parallel ensure* without stampeding Railway
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
    // Serverless safety: Hyperdrive/Railway kill idle backend connections
    // without RST, so a pooled socket can be dead while looking alive. TCP
    // keepalives detect that, and a client-side query timeout turns a
    // would-hang-forever checkout (the Workers runtime kills the isolate
    // and the page 500s) into a fast, retryable error instead.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: 15_000,
    // Don't fail the whole pool on one bad connection during cold start
    allowExitOnIdle: true,
  });
  p.on("error", (err) => {
    console.error("Unexpected Postgres pool error:", err.message);
  });
  return p;
}

function getPool(): Pool {
  if (!poolInstance) poolInstance = createPool();
  return poolInstance;
}

export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const real = getPool();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(getPool(), prop, value, getPool());
  },
  has(_target, prop) {
    return Reflect.has(getPool(), prop);
  },
  getPrototypeOf() {
    return Pool.prototype;
  },
});

export const db = drizzle(pool, { schema });

function errCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  if ("code" in err && err.code != null) return String(err.code);
  // Drizzle wraps pg errors in cause
  if ("cause" in err && err.cause && typeof err.cause === "object" && "code" in err.cause) {
    return String((err.cause as { code: unknown }).code);
  }
  return "";
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const nested =
      "cause" in err && err.cause instanceof Error ? err.cause.message : "";
    return nested ? `${err.message} ${nested}` : err.message;
  }
  return String(err);
}

/** True for Railway cold starts, dropped connections, timeouts, etc. */
export function isTransientDbError(err: unknown): boolean {
  const code = errCode(err);
  const message = errMessage(err).toLowerCase();

  // Permanent schema/query errors — retrying is pure burn (8 attempts of
  // backoff on something that will never succeed, e.g. a missing column on
  // a DB where migrations haven't applied). Fail fast so callers' fallbacks
  // kick in immediately.
  if (
    code === "42703" || // undefined_column
    code === "42704" || // undefined_object
    code === "42883" || // undefined_function
    code === "42P01" || // undefined_table
    code === "42601" || // syntax_error
    code === "42846" || // cannot_coerce
    code === "23502" || // not_null_violation
    code === "23503" || // foreign_key_violation
    code === "23505" || // unique_violation
    code === "22P02" // invalid_text_representation
  ) {
    return false;
  }

  if (
    code === "57P03" || // starting up
    code === "57P01" || // admin shutdown
    code === "08006" || // connection failure
    code === "08001" || // sqlclient unable to establish
    code === "08003" || // connection does not exist
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  return (
    message.includes("starting up") ||
    message.includes("connection terminated") ||
    message.includes("connection closed") ||
    message.includes("connection reset") ||
    message.includes("connection refused") ||
    message.includes("query read timeout") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("timeout") ||
    message.includes("too many clients") ||
    message.includes("server closed the connection") ||
    message.includes("cannot connect") ||
    message.includes("failed query") // Drizzle wrapper; often wraps transient cause
  );
}

/**
 * Run a DB operation with retries on transient connection / cold-start errors.
 * Total wait is capped by maxElapsedMs: on Workers an unbounded retry storm
 * outlives the request (the runtime kills the isolate and the page 500s), and
 * anywhere else a page waiting >~25s on the DB is dead anyway — fail fast so
 * callers' fallbacks kick in instead of hanging the render.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 8,
  baseDelayMs = 1500,
  maxElapsedMs = 25_000
): Promise<T> {
  let lastError: unknown;
  const deadline = Date.now() + maxElapsedMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * attempt, 8_000);
      if (Date.now() + delay >= deadline) {
        throw err;
      }
      console.warn(
        `DB transient error (attempt ${attempt}/${maxAttempts}): ${errMessage(err)}. Retrying in ${delay}ms…`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Ping the DB with retries. Use after cold starts when Postgres
 * returns 57P03 ("the database system is starting up").
 */
export async function pingDb(maxAttempts = 8, baseDelayMs = 1500): Promise<void> {
  await withDbRetry(async () => {
    await pool.query("SELECT 1");
  }, maxAttempts, baseDelayMs);
}

/**
 * Run async work over items with limited concurrency (avoids pool exhaustion
 * when ensuring 100+ shows in parallel).
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
