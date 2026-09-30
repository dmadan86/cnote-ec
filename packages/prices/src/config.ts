// Price-intelligence configuration (ADR-022). Env is read lazily so tests and the worker can flip it at runtime.
// The k threshold is editable by staff (audited in the admin app): DB value wins, then PRICE_K, then 5.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";

export const DEFAULT_K = 5;
export const MIN_K = 3;
export const MAX_K = 100;
/** Trailing window (days) each period's benchmarks are computed over. */
export const WINDOW_DAYS = 90;

export const priceIntelEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.PRICE_INTEL_ENABLED ?? "");

export function assertPriceIntelEnabled(): void {
  if (!priceIntelEnabled()) throw new DomainError("forbidden", "Price intelligence is not available yet.");
}

export const clampK = (n: number): number => Math.min(MAX_K, Math.max(MIN_K, Math.trunc(n)));

/** Escrow-settled orders are real transactions, so they weigh more than quotes in percentiles (default 3, range 1..10). */
export function escrowWeight(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PRICE_ESCROW_WEIGHT);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3;
}

export async function getK(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const row = await prisma.priceConfig.findUnique({ where: { key: "k" } });
  const fromDb = row && typeof row.value === "number" ? row.value : undefined;
  if (fromDb !== undefined) return clampK(fromDb);
  const fromEnv = Number(env.PRICE_K);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? clampK(fromEnv) : DEFAULT_K;
}

/** Stored as the value in force from the NEXT run; callers (admin) wrap this in `audited()`. */
export async function setK(k: number, staffId: string | null): Promise<number> {
  if (!Number.isInteger(k) || k < MIN_K || k > MAX_K) throw new DomainError("validation", `k must be a whole number between ${MIN_K} and ${MAX_K}.`);
  await prisma.priceConfig.upsert({ where: { key: "k" }, create: { key: "k", value: k, updatedBy: staffId }, update: { value: k, updatedBy: staffId } });
  return k;
}
