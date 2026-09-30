// DPDP retention hook for @cnote/compliance (ADR-010): purge closed credit data older than `before`.
// Open loans and their applications are never touched. Score snapshots older than `before` go, but the latest per business stays.
import { prisma } from "@cnote/db";

export interface CreditPurgeResult { loans: number; repayments: number; applications: number; offers: number; assignments: number; shares: number; scores: number; webhookEvents: number }

export async function purgeClosedCreditData(before: Date): Promise<CreditPurgeResult> {
  return prisma.$transaction(async (tx) => {
    const loans = await tx.creditLoan.findMany({ where: { status: { in: ["repaid", "written_off"] }, closedAt: { lt: before } }, select: { id: true, applicationId: true } });
    const loanIds = loans.map((l) => l.id);
    const terminal = await tx.creditApplication.findMany({
      where: { OR: [{ id: { in: loans.map((l) => l.applicationId) } }, { status: { in: ["rejected", "declined", "expired", "failed", "cancelled"] }, closedAt: { lt: before } }] }, select: { id: true },
    });
    const appIds = terminal.map((a) => a.id);
    const repayments = await tx.creditRepayment.deleteMany({ where: { loanId: { in: loanIds } } });
    const assignments = await tx.creditAssignment.deleteMany({ where: { loanId: { in: loanIds } } });
    const loansDel = await tx.creditLoan.deleteMany({ where: { id: { in: loanIds } } });
    const offers = await tx.creditOffer.deleteMany({ where: { applicationId: { in: appIds } } });
    const shares = await tx.creditPartnerShare.deleteMany({ where: { applicationId: { in: appIds } } });
    const apps = await tx.creditApplication.deleteMany({ where: { id: { in: appIds } } });
    const webhookEvents = await tx.creditWebhookEvent.deleteMany({ where: { receivedAt: { lt: before } } });
    const latest = await tx.creditScore.findMany({ distinct: ["businessId"], orderBy: [{ businessId: "asc" }, { computedAt: "desc" }], select: { id: true } });
    const scores = await tx.creditScore.deleteMany({ where: { computedAt: { lt: before }, id: { notIn: latest.map((s) => s.id) } } });
    return {
      loans: loansDel.count, repayments: repayments.count, applications: apps.count, offers: offers.count, assignments: assignments.count,
      shares: shares.count, scores: scores.count, webhookEvents: webhookEvents.count,
    };
  });
}
