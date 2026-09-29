import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export { EMBEDDING_DIM, toVectorLiteral } from "./vector";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "postgres://cnote:cnote@localhost:5432/cnote",
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
