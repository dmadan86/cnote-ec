import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export { EMBEDDING_DIM, toVectorLiteral } from "./vector";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Connection string for this client. There is NO silent localhost fallback in production (security audit M8): a production process without
 * DATABASE_URL gets `null` and an "unconfigured" client that throws on first use. (It must not throw at import: `next build` / `next typegen`
 * import this module without a database, and startup validation, packages/security/src/secrets.ts, is what stops a misconfigured app booting.)
 */
function connectionString(): string | null {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  return process.env.NODE_ENV === "production" ? null : "postgres://cnote:cnote@localhost:5432/cnote";
}

function unconfiguredClient(): never {
  throw new Error("DATABASE_URL is required in production (no localhost fallback)");
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

export const prisma = globalForPrisma.prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Interactive-transaction client. Pass it to anything that must commit atomically with your write (e.g. emit()). */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
export type DbClient = PrismaClient | Tx;

/**
 * Runs `fn` in a transaction that is allowed to DELETE from the DB-level append-only tables (security audit M5; migration
 * 20261003000000_append_only_triggers). ONLY retention purges and tests may use this: the triggers reject DELETE/TRUNCATE
 * on the audit log, ledgers, consents, domain events and cookie-consent receipts unless `cnote.allow_purge` is on, and the
 * setting is transaction-local (`set_config(..., true)`), so it cannot leak to other queries on the pooled connection.
 */
export async function withPurge<T>(fn: (tx: Tx) => Promise<T>, client: PrismaClient = prisma): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('cnote.allow_purge', 'on', true)`;
      return fn(tx);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}
