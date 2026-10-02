import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/live/client";

export * from "./generated/live/client";
export { EMBEDDING_DIM, toVectorLiteral } from "./vector";

const globalForLive = globalThis as unknown as { livePrisma?: PrismaClient };

/**
 * Connection string for this client. There is NO silent localhost fallback in production (security audit M8): a production process without
 * LIVE_DATABASE_URL gets `null` and an "unconfigured" client that throws on first use. (It must not throw at import: `next build` / `next typegen`
 * import this module without a database, and startup validation, packages/security/src/secrets.ts, is what stops a misconfigured app booting.)
 */
function connectionString(): string | null {
  const url = process.env.LIVE_DATABASE_URL;
  if (url) return url;
  return process.env.NODE_ENV === "production" ? null : "postgres://cnote:cnote@localhost:5432/cnote_live";
}

function unconfiguredClient(): never {
  throw new Error("LIVE_DATABASE_URL is required in production (no localhost fallback)");
}

function createClient() {
  if (connectionString() === null) return new Proxy({} as PrismaClient, { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : unconfiguredClient()) });
  const adapter = new PrismaPg({
    connectionString: connectionString()!,
    // Pool size per process. Keep small where many processes share one Postgres (e.g. `next build` runs
    // ~10 prerender workers); PgBouncer/managed poolers in production. Default matches node-postgres (10).
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    // Pin the session to UTC: the pg driver adapter sends timestamps without an offset, so a non-UTC
    // server/database TimeZone (e.g. Asia/Kolkata on a laptop or some managed DBs) would shift every
    // stored instant. Never rely on the server default.
    options: "-c TimeZone=UTC",
  });
  return new PrismaClient({ adapter });
}

/** Client for the LIVE read database (published projections only). Never points at the authoring DB. */
export const liveDb = globalForLive.livePrisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForLive.livePrisma = liveDb;

export type LiveTx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
