import type { ModuleWorker } from "@cnote/core";
import { computeDay } from "./compute";
import { addDays, daysBetween, istDay } from "./time";

/** Days re-derived nightly: the longest follow-up window (30d deal reports) plus one. Longer windows (90d badge) refresh via backfill. */
export const NIGHTLY_LOOKBACK_DAYS = 31;

export async function refreshRecent(now: Date = new Date()): Promise<void> {
  const today = istDay(now);
  await computeDay(today);
  await computeDay(addDays(today, -1));
}

export async function nightly(now: Date = new Date()): Promise<void> {
  const today = istDay(now);
  for (const d of daysBetween(addDays(today, -NIGHTLY_LOOKBACK_DAYS), addDays(today, -1)).reverse()) await computeDay(d);
}

let lastNightly: string | null = null;

/** Runs `nightly` once per IST day, in the 02:00-02:59 IST hour (job ticks every 20 minutes; idempotent if two workers race). */
export async function maybeNightly(now: Date = new Date()): Promise<boolean> {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const today = istDay(now);
  if (ist.getUTCHours() !== 2 || lastNightly === today) return false;
  lastNightly = today;
  await nightly(now);
  return true;
}

export function resetNightlyMarker(): void {
  lastNightly = null;
}

export const worker: ModuleWorker = {
  name: "metrics",
  handlers: {},
  jobs: [
    { name: "metrics.refresh-recent", everyMs: 15 * 60_000, run: () => refreshRecent() },
    { name: "metrics.nightly", everyMs: 20 * 60_000, run: async () => void (await maybeNightly()) },
  ],
};
