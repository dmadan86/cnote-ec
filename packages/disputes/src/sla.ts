// SLA tracking (target: median 7 days), the scheduled advance loop, and metrics.
import { prisma } from "@cnote/db";
import { DAY_MS, SLA_DAYS, disputesEnabled } from "./config";
import { collectEvidence, queueBrief } from "./brief";
import { enqueueBrief, enqueueCollect } from "./jobs";
import { finalizeAutoResolutions } from "./resolve";
import { ACTIVE_STATUSES, median } from "./state";
import type { DisputeMetrics } from "./types";

/** Flags active cases past their 7-day SLA (once). Returns how many were newly flagged. */
export async function flagOverdueDisputes(now = new Date()): Promise<number> {
  const r = await prisma.dispute.updateMany({ where: { status: { in: ACTIVE_STATUSES }, dueAt: { lt: now }, overdueFlaggedAt: null }, data: { overdueFlaggedAt: now } });
  return r.count;
}

/**
 * One tick of the scheduled loop (idempotent; every step is safe to repeat):
 *  1. response window over -> queue the AI brief; 2. backstop for lost collect/brief jobs; 3. finalise auto-resolutions
 *  whose escalation window closed; 4. flag SLA breaches.
 */
export async function advanceDisputes(now = new Date()): Promise<{ briefed: number; requeued: number; autoResolved: number; overdue: number }> {
  const windowOver = await prisma.dispute.findMany({ where: { status: "open", responseDueAt: { lte: now } }, select: { id: true }, take: 200 });
  let briefed = 0;
  for (const { id } of windowOver) if (await queueBrief(id)) briefed++;

  // Lost jobs: no order evidence after a minute, or a queued brief with no result for 30 minutes.
  const hourBucket = `:${Math.floor(now.getTime() / 3_600_000)}`;
  const noEvidence = await prisma.dispute.findMany({
    where: { status: { in: ["open", "evidence"] }, createdAt: { lt: new Date(now.getTime() - 60_000) }, evidence: { none: { source: "auto:order" } } }, select: { id: true }, take: 100,
  });
  for (const { id } of noEvidence) await enqueueCollect(id, hourBucket);
  const stuck = await prisma.dispute.findMany({
    where: { status: "evidence", briefQueuedAt: { lt: new Date(now.getTime() - 30 * 60_000) }, briefs: { none: {} } }, select: { id: true }, take: 100,
  });
  for (const { id } of stuck) await enqueueBrief(id, hourBucket);

  const autoResolved = await finalizeAutoResolutions(now);
  const overdue = await flagOverdueDisputes(now);
  return { briefed, requeued: noEvidence.length + stuck.length, autoResolved, overdue };
}

/** Scheduled entry: a no-op while DISPUTES_ENABLED is off. */
export async function runAdvanceJob(): Promise<void> {
  if (!disputesEnabled()) return;
  const r = await advanceDisputes();
  if (r.briefed || r.requeued || r.autoResolved || r.overdue) console.log("[disputes] advance", r);
}

export { collectEvidence };

/** ADR-013 success metrics from the dispute tables (median time to resolution vs the 7-day target, SLA share, auto share...). */
export async function disputeMetrics(opts: { from?: Date; to?: Date; now?: Date } = {}): Promise<DisputeMetrics> {
  const now = opts.now ?? new Date();
  const createdAt = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) };
  const rows = await prisma.dispute.findMany({
    where: { createdAt },
    select: { id: true, status: true, createdAt: true, resolvedAt: true, dueAt: true, decision: { select: { outcome: true, decidedBy: true, followedRecommendation: true } }, briefs: { select: { id: true }, take: 1 } },
  });
  const decided = rows.filter((r) => r.status === "resolved" && r.resolvedAt);
  const durations = decided.map((r) => r.resolvedAt!.getTime() - r.createdAt.getTime());
  const med = median(durations);
  const appeals = await prisma.disputeAppeal.count({ where: { disputeId: { in: decided.map((r) => r.id) } } });
  const withBrief = decided.filter((r) => r.briefs.length > 0 && r.decision);
  const share = (n: number, d: number) => (d === 0 ? null : n / d);
  return {
    opened: rows.length,
    resolved: decided.length,
    withdrawn: rows.filter((r) => r.status === "withdrawn").length,
    medianResolutionMs: med,
    medianResolutionDays: med === null ? null : med / DAY_MS,
    targetDays: SLA_DAYS,
    meetsTarget: med === null ? null : med <= SLA_DAYS * DAY_MS,
    withinSlaShare: share(decided.filter((r) => r.resolvedAt! <= r.dueAt).length, decided.length),
    autoResolvedShare: share(decided.filter((r) => r.decision?.decidedBy === "auto").length, decided.length),
    overdueActive: rows.filter((r) => (ACTIVE_STATUSES as string[]).includes(r.status) && r.dueAt < now).length,
    appealRate: share(appeals, decided.length),
    briefAgreementRate: share(withBrief.filter((r) => r.decision!.followedRecommendation).length, withBrief.length),
  };
}
