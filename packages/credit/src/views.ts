import { prisma, type CreditApplication, type CreditLoan, type CreditOffer } from "@cnote/db";
import { getCreditPartner } from "./partner";
import type { ApplicationStatus, ApplicationView, Kfs, LoanStatus, LoanView, OfferView, Product } from "./types";

export const num = (b: bigint | null | undefined): number => Number(b ?? 0n);

export const toOfferView = (o: CreditOffer): OfferView => ({
  id: o.id, amountPaise: num(o.amountPaise), aprBps: o.aprBps, tenorDays: o.tenorDays, processingFeePaise: num(o.processingFeePaise), otherFeesPaise: num(o.otherFeesPaise),
  interestPaise: num(o.interestPaise), totalRepayablePaise: num(o.totalRepayablePaise), kfs: o.kfs as unknown as Kfs, status: o.status, expiresAt: o.expiresAt.toISOString(),
});

export const outstandingOf = (l: Pick<CreditLoan, "totalRepayablePaise" | "repaidPaise">): number => Math.max(0, num(l.totalRepayablePaise) - num(l.repaidPaise));

export function toLoanView(l: CreditLoan, repayments: { amountPaise: bigint; source: string; paidAt: Date }[] = []): LoanView {
  return {
    id: l.id, applicationId: l.applicationId, businessId: l.businessId, product: l.product as Product, orderId: l.orderId, escrowId: l.escrowId, partner: l.partner,
    principalPaise: num(l.principalPaise), aprBps: l.aprBps, tenorDays: l.tenorDays, totalRepayablePaise: num(l.totalRepayablePaise), repaidPaise: num(l.repaidPaise),
    outstandingPaise: outstandingOf(l), status: l.status as LoanStatus, dpd: l.dpd, disbursedAt: l.disbursedAt.toISOString(), dueAt: l.dueAt.toISOString(),
    closedAt: l.closedAt?.toISOString() ?? null,
    repayments: repayments.map((r) => ({ amountPaise: num(r.amountPaise), source: r.source, paidAt: r.paidAt.toISOString() })),
  };
}

function lenderName(partner: string): string {
  try { return getCreditPartner(partner).lender.name; } catch { return partner; }
}

/** Application with its offers and loan, batched for a list. */
export async function toApplicationViews(apps: CreditApplication[]): Promise<ApplicationView[]> {
  if (apps.length === 0) return [];
  const ids = apps.map((a) => a.id);
  const [offers, loans] = await Promise.all([
    prisma.creditOffer.findMany({ where: { applicationId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    prisma.creditLoan.findMany({ where: { applicationId: { in: ids } } }),
  ]);
  const reps = await prisma.creditRepayment.findMany({ where: { loanId: { in: loans.map((l) => l.id) } }, orderBy: { paidAt: "asc" } });
  return apps.map((a) => {
    const loan = loans.find((l) => l.applicationId === a.id);
    return {
      id: a.id, businessId: a.businessId, product: a.product as Product, orderId: a.orderId, escrowId: a.escrowId, amountPaise: num(a.amountPaise), orderAmountPaise: num(a.orderAmountPaise),
      tenorDays: a.tenorDays, status: a.status as ApplicationStatus, reason: a.reason, partner: a.partner, lenderName: lenderName(a.partner), createdAt: a.createdAt.toISOString(),
      offers: offers.filter((o) => o.applicationId === a.id).map(toOfferView),
      loan: loan ? toLoanView(loan, reps.filter((r) => r.loanId === loan.id)) : null,
    };
  });
}
