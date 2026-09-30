import type { ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { priceIntelEnabled } from "./config";
import { runBenchmarks } from "./run";

const HOUR_MS = 3_600_000;

/** Nightly aggregation: checked every 6h, runs when no nightly run finished in the last 20h. Idempotent; flag-gated. */
export async function runNightlyIfDue(now = new Date()): Promise<boolean> {
  if (!priceIntelEnabled()) return false;
  const recent = await prisma.priceBenchmarkRun.findFirst({
    where: { trigger: "nightly", status: { in: ["completed", "running"] }, startedAt: { gt: new Date(now.getTime() - 20 * HOUR_MS) } },
  });
  if (recent) return false;
  return (await runBenchmarks({ trigger: "nightly", now })) !== null;
}

export const worker: ModuleWorker = {
  name: "prices",
  handlers: {},
  jobs: [{ name: "prices.nightly-benchmarks", everyMs: 6 * HOUR_MS, run: async () => void (await runNightlyIfDue()) }],
};
