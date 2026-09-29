import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/live/client";

export * from "./generated/live/client";
export { EMBEDDING_DIM, toVectorLiteral } from "./vector";

const globalForLive = globalThis as unknown as { livePrisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.LIVE_DATABASE_URL ?? "postgres://cnote:cnote@localhost:5432/cnote_live",
    // Pool size per process. Keep small where many processes share one Postgres (e.g. `next build` runs
    // ~10 prerender workers); PgBouncer/managed poolers in production. Default matches node-postgres (10).
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
  return new PrismaClient({ adapter });
}

/** Client for the LIVE read database (published projections only). Never points at the authoring DB. */
export const liveDb = globalForLive.livePrisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForLive.livePrisma = liveDb;

export type LiveTx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
