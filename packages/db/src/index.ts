import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export { EMBEDDING_DIM, toVectorLiteral } from "./vector";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "postgres://cnote:cnote@localhost:5432/cnote",
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Interactive-transaction client. Pass it to anything that must commit atomically with your write (e.g. emit()). */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
export type DbClient = PrismaClient | Tx;
