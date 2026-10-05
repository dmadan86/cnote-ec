// DPDP (ADR-010) for approvals: what this module holds about a person can be exported and erased, and records age out.
// The decision log is append-only in Postgres: erasure may only null the free-text `comment`; the pseudonymous person id stays
// (the person row itself is tombstoned), which keeps the business's own audit trail intact (DPDP s.8(7) / Companies Act records).
import { prisma, withPurge } from "@cnote/db";

/** Access right: requests the person raised, decisions they made, delegations, their cap and spend. */
export async function exportApprovalsData(personId: string): Promise<Record<string, unknown>> {
  const [requests, decisions, delegations, limits, spend] = await Promise.all([
    prisma.approvalRequest.findMany({ where: { requesterPersonId: personId }, orderBy: { createdAt: "asc" }, take: 1000 }),
    prisma.approvalDecision.findMany({ where: { OR: [{ deciderPersonId: personId }, { onBehalfOfPersonId: personId }] }, orderBy: { createdAt: "asc" }, take: 1000 }),
    prisma.approvalDelegation.findMany({ where: { OR: [{ delegatorPersonId: personId }, { delegatePersonId: personId }] }, orderBy: { createdAt: "asc" }, take: 500 }),
    prisma.memberSpendLimit.findMany({ where: { personId } }),
    prisma.spendRecord.findMany({ where: { personId }, orderBy: { occurredAt: "asc" }, take: 2000 }),
  ]);
  return {
    approvalRequests: requests.map((r) => ({ businessId: r.businessId, action: r.action, subject: { type: r.subjectType, id: r.subjectId, summary: r.subjectSummary }, amountPaise: r.amountPaise, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt })),
    approvalDecisions: decisions.map((d) => ({ requestId: d.requestId, level: d.level, kind: d.kind, onBehalfOfPersonId: d.onBehalfOfPersonId, comment: d.comment, createdAt: d.createdAt })),
    approvalDelegations: delegations.map((d) => ({ businessId: d.businessId, delegatorPersonId: d.delegatorPersonId, delegatePersonId: d.delegatePersonId, startsAt: d.startsAt, endsAt: d.endsAt, revokedAt: d.revokedAt })),
    spendLimits: limits.map((l) => ({ businessId: l.businessId, monthlyCapPaise: l.monthlyCapPaise })),
    spendRecords: spend.map((s) => ({ businessId: s.businessId, amountPaise: s.amountPaise, action: s.action, subject: { type: s.subjectType, id: s.subjectId }, occurredAt: s.occurredAt })),
  };
}

/** Erasure: free-text comments by the person are nulled, delegations and caps are deleted. Idempotent. */
export async function eraseApprovalsData(personId: string): Promise<void> {
  await prisma.$transaction([
    prisma.approvalDecision.updateMany({ where: { deciderPersonId: personId, comment: { not: null } }, data: { comment: null } }),
    prisma.approvalDelegation.deleteMany({ where: { OR: [{ delegatorPersonId: personId }, { delegatePersonId: personId }] } }),
    prisma.memberSpendLimit.deleteMany({ where: { personId } }),
  ]);
}

/** Registry-shaped alias of exportApprovalsData (security audit M10). */
export const exportPersonalData = (personId: string) => exportApprovalsData(personId);

/** Storage limitation: resolved requests and their decision log older than the retention horizon (default 8 years). */
export async function purgeResolvedRequests(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { status: { not: "pending" as const }, resolvedAt: { lt: before } };
  if (opts.dryRun) return prisma.approvalRequest.count({ where });
  return withPurge(async (tx) => {
    await tx.approvalDecision.deleteMany({ where: { request: where } });
    return (await tx.approvalRequest.deleteMany({ where })).count;
  });
}

/** Ended or revoked delegations carry no purpose after a year. */
export async function purgeEndedDelegations(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { OR: [{ endsAt: { lt: before } }, { revokedAt: { lt: before } }] };
  if (opts.dryRun) return prisma.approvalDelegation.count({ where });
  return (await prisma.approvalDelegation.deleteMany({ where })).count;
}

