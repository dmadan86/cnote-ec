// SLA job: remind the approvers of a level that has waited past its SLA (up to APPROVAL_MAX_REMINDERS), then expire requests nobody
// decides. Safe to run on every worker and repeatedly: each step is conditional on the row's current state.
import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { expiryMs, maxReminders, slaMs } from "./config";
import { activeDelegations, eligibleFor, teamRoles, withDelegates } from "./eligibility";
import { expireRequest } from "./requests";
import type { ChainLevel } from "./types";

export async function runSlaSweep(now = new Date()): Promise<{ reminded: number; expired: number }> {
  let expired = 0;
  const stale = await prisma.approvalRequest.findMany({ where: { status: "pending", createdAt: { lte: new Date(now.getTime() - expiryMs()) } }, select: { id: true }, take: 200 });
  for (const r of stale) if (await expireRequest(r.id, now)) expired++;

  let reminded = 0;
  const due = await prisma.approvalRequest.findMany({
    where: { status: "pending", dueAt: { lte: now }, reminderCount: { lt: maxReminders() } },
    include: { decisions: { select: { deciderPersonId: true, onBehalfOfPersonId: true } } },
    orderBy: { dueAt: "asc" },
    take: 200,
  });
  for (const r of due) {
    const cur = ((r.levels as unknown as ChainLevel[]) ?? []).find((l) => l.level === r.currentLevel);
    if (!cur) continue;
    const exclude = new Set<string>([r.requesterPersonId]);
    for (const d of r.decisions) {
      if (d.deciderPersonId) exclude.add(d.deciderPersonId);
      if (d.onBehalfOfPersonId) exclude.add(d.onBehalfOfPersonId);
    }
    const [roles, delegs] = await Promise.all([teamRoles(r.businessId), activeDelegations(r.businessId, now)]);
    const approvers = eligibleFor(cur, roles, exclude);
    await prisma.$transaction(async (tx) => {
      // conditional claim: a concurrent sweep that already reminded this level moves nothing
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: r.id, status: "pending", reminderCount: r.reminderCount, dueAt: { lte: now } },
        data: { reminderCount: { increment: 1 }, lastReminderAt: now, dueAt: new Date(now.getTime() + slaMs()) },
      });
      if (claimed.count === 0) return;
      reminded++;
      if (approvers.length === 0) return; // nobody to remind; expiry will close it
      await emit(tx, "ApprovalReminder", { type: "approval", id: r.id }, {
        requestId: r.id, businessId: r.businessId, subjectSummary: r.subjectSummary, level: r.currentLevel, reminderNo: r.reminderCount + 1, approverPersonIds: withDelegates(approvers, delegs, roles, exclude),
      });
    });
  }
  return { reminded, expired };
}
