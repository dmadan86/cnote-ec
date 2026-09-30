import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { toVerticalView } from "./mappers";
import { getVerticalStatsPort } from "./stats";
import type { GateResult, VerticalView } from "./types";

const DAY_MS = 86_400_000;
/** Minimum tier that counts as "verified" (ADR-003 T1: GSTIN). */
export const VERIFIED_MIN_TIER = 1;

/** IST calendar day (YYYY-MM-DD) for snapshot keys. */
export const istDay = (at: Date = new Date()): string => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const dayToDate = (day: string) => new Date(`${day}T00:00:00Z`);
const daysAgo = (day: string, n: number) => new Date(dayToDate(day).getTime() - n * DAY_MS);

/**
 * Baseline for a trailing window: the latest snapshot on or before (today - window); when history is shorter than the
 * window, the earliest earlier snapshot (partial window, reported via baselineDays). None: netAdds is null and the gate fails.
 */
async function baseline(verticalId: string, today: string, window: number): Promise<{ verifiedSellers: number; days: number } | null> {
  const row =
    (await prisma.verticalMetricSnapshot.findFirst({ where: { verticalId, day: { lte: daysAgo(today, window) } }, orderBy: { day: "desc" } })) ??
    (await prisma.verticalMetricSnapshot.findFirst({ where: { verticalId, day: { lt: dayToDate(today) } }, orderBy: { day: "asc" } }));
  if (!row) return null;
  return { verifiedSellers: row.verifiedSellers, days: Math.round((dayToDate(today).getTime() - row.day.getTime()) / DAY_MS) };
}

export async function evaluateGatesFor(v: VerticalView, now: Date = new Date()): Promise<GateResult> {
  const today = istDay(now);
  const verifiedSellers = await getVerticalStatsPort().countVerifiedSellers(v.categorySlugs, VERIFIED_MIN_TIER);
  const [b30, b90] = await Promise.all([baseline(v.id, today, 30), baseline(v.id, today, 90)]);
  const netAdds30 = b30 ? verifiedSellers - b30.verifiedSellers : null;
  const netAdds90 = b90 ? verifiedSellers - b90.verifiedSellers : null;
  const checks = {
    verifiedSellers: verifiedSellers >= v.gates.minVerifiedSellers,
    netAdds30: netAdds30 !== null && netAdds30 >= v.gates.minNetAdds30,
    netAdds90: netAdds90 !== null && netAdds90 >= v.gates.minNetAdds90,
  };
  return {
    verticalId: v.id,
    slug: v.slug,
    verifiedSellers,
    netAdds30,
    netAdds90,
    baselineDays30: b30?.days ?? null,
    baselineDays90: b90?.days ?? null,
    thresholds: v.gates,
    checks,
    meetsGates: checks.verifiedSellers && checks.netAdds30 && checks.netAdds90,
    evaluatedAt: now.toISOString(),
  };
}

/** ADR-016: verified sellers (tier >= 1, live listing in the vertical's categories) and net adds over trailing 30/90 days. */
export async function evaluateVerticalGates(verticalId: string, now: Date = new Date()): Promise<GateResult> {
  const row = await prisma.vertical.findUnique({ where: { id: verticalId } });
  if (!row) throw new DomainError("not_found", "Vertical not found.");
  return evaluateGatesFor(toVerticalView(row), now);
}

/** Open verticals (other than `exceptId`) that currently fail their gates: they block new launches. */
export async function blockingVerticals(exceptId?: string, now: Date = new Date()): Promise<GateResult[]> {
  const open = await prisma.vertical.findMany({ where: { stage: "open", ...(exceptId ? { id: { not: exceptId } } : {}) }, orderBy: { slug: "asc" } });
  const results = await Promise.all(open.map((r) => evaluateGatesFor(toVerticalView(r), now)));
  return results.filter((r) => !r.meetsGates);
}

/** Writes today's snapshot (idempotent: one row per vertical per IST day, last write wins). */
export async function snapshotVertical(verticalId: string, now: Date = new Date()): Promise<GateResult> {
  const r = await evaluateVerticalGates(verticalId, now);
  const day = dayToDate(istDay(now));
  const data = { verifiedSellers: r.verifiedSellers, netAdds30: r.netAdds30, netAdds90: r.netAdds90, meetsGates: r.meetsGates };
  await prisma.verticalMetricSnapshot.upsert({ where: { verticalId_day: { verticalId, day } }, create: { verticalId, day, ...data }, update: data });
  return r;
}

/** Snapshots every vertical (candidates included) so candidates accumulate history before they are considered. */
export async function snapshotAllVerticals(now: Date = new Date()): Promise<number> {
  const all = await prisma.vertical.findMany({ select: { id: true } });
  let n = 0;
  for (const { id } of all) {
    try {
      await snapshotVertical(id, now);
      n++;
    } catch (err) {
      console.error(`[verticals] snapshot failed for ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}

export async function listSnapshots(verticalId: string, days = 120): Promise<{ day: string; verifiedSellers: number; netAdds30: number | null; netAdds90: number | null; meetsGates: boolean }[]> {
  const rows = await prisma.verticalMetricSnapshot.findMany({ where: { verticalId, day: { gte: daysAgo(istDay(), days) } }, orderBy: { day: "asc" } });
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), verifiedSellers: r.verifiedSellers, netAdds30: r.netAdds30, netAdds90: r.netAdds90, meetsGates: r.meetsGates }));
}
