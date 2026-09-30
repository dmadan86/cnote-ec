// ADR-019 metrics + FLDG tracking + staff reads. Inputs for @cnote/metrics (the lead wires them).
import { escrowStats } from "@cnote/escrow";
import { prisma } from "@cnote/db";
import { creditConfig } from "./config";
import { toApplicationViews, toLoanView, num, outstandingOf } from "./views";
import type { ApplicationView, LoanView } from "./types";

export const NPA_DPD = 90;

export interface BookLoan { outstandingPaise: number; dpd: number; status: string; writtenOffPaise: number }

/**
 * Gross NPA ratio: (outstanding on loans >= 90 DPD + written-off amounts) / (outstanding on open loans + written-off amounts).
 * Written-off loans stay in both numerator and denominator so a write-off never improves the ratio. Closed (repaid) loans are excluded.
 */
export function computeGnpa(loans: BookLoan[]): { gnpaRatio: number; gnpaPaise: number; bookPaise: number } {
  let gnpa = 0, book = 0;
  for (const l of loans) {
    if (l.status === "repaid" || l.status === "cancelled") continue;
    if (l.status === "written_off") { gnpa += l.writtenOffPaise; book += l.writtenOffPaise; continue; }
    book += l.outstandingPaise;
    if (l.dpd >= NPA_DPD) gnpa += l.outstandingPaise;
  }
  return { gnpaRatio: book > 0 ? gnpa / book : 0, gnpaPaise: gnpa, bookPaise: book };
}

export interface PartnerGnpa { partner: string; gnpaRatio: number; gnpaPaise: number; bookPaise: number; loans: number; targetRatio: number; withinTarget: boolean }

/** Partner GNPA on the platform-originated book (target < 2%), per partner. */
export async function partnerGnpa(): Promise<PartnerGnpa[]> {
  const rows = await prisma.creditLoan.findMany({ where: { status: { notIn: ["repaid", "cancelled"] } } });
  const target = creditConfig().gnpaTargetBps / 10_000;
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.partner, [...(by.get(r.partner) ?? []), r]);
  return [...by.entries()].map(([partner, ls]) => {
    const g = computeGnpa(ls.map((l) => ({ outstandingPaise: outstandingOf(l), dpd: l.dpd, status: l.status, writtenOffPaise: num(l.writtenOffPaise) })));
    return { partner, ...g, loans: ls.length, targetRatio: target, withinTarget: g.gnpaRatio < target };
  });
}

/** Overall GNPA across partners (0 for an empty book). */
export async function overallGnpa(): Promise<{ gnpaRatio: number; gnpaPaise: number; bookPaise: number }> {
  const rows = await prisma.creditLoan.findMany({ where: { status: { notIn: ["repaid", "cancelled"] } } });
  return computeGnpa(rows.map((l) => ({ outstandingPaise: outstandingOf(l), dpd: l.dpd, status: l.status, writtenOffPaise: num(l.writtenOffPaise) })));
}

export interface AttachedShare { attachedOrders: number; attachedGmvPaise: number; escrowedGmvPaise: number; share: number; targetShare: number; meetsTarget: boolean }

/** Pure: credit-attached GMV / escrowed GMV (0 when nothing was escrowed). */
export const attachedShare = (attachedGmvPaise: number, escrowedGmvPaise: number): number => (escrowedGmvPaise > 0 ? Math.min(1, attachedGmvPaise / escrowedGmvPaise) : 0);

/** Credit-attached orders (distinct escrowed orders with a disbursed loan in range) as a share of escrowed GMV funded in range (target >= 15%). */
export async function creditAttachedGmvShare(range: { from: Date; to: Date }): Promise<AttachedShare> {
  const loans = await prisma.creditLoan.findMany({ where: { disbursedAt: { gte: range.from, lt: range.to }, status: { not: "cancelled" } }, select: { orderId: true, orderAmountPaise: true } });
  const distinct = new Map(loans.map((l) => [l.orderId, num(l.orderAmountPaise)]));
  const attachedGmvPaise = [...distinct.values()].reduce((a, b) => a + b, 0);
  const escrowedGmvPaise = (await escrowStats(range)).fundedPaise;
  const share = attachedShare(attachedGmvPaise, escrowedGmvPaise);
  const targetShare = creditConfig().attachedGmvTargetBps / 10_000;
  return { attachedOrders: distinct.size, attachedGmvPaise, escrowedGmvPaise, share, targetShare, meetsTarget: share >= targetShare };
}

export interface CreditStats {
  applications: number;
  offered: number;
  accepted: number;
  rejected: number;
  disbursedLoans: number;
  disbursedPaise: number;
  repaidPaise: number;
  outstandingPaise: number;
  overdueLoans: number;
}

export async function creditStats(range: { from: Date; to: Date }): Promise<CreditStats> {
  const created = { gte: range.from, lt: range.to };
  const [apps, loans, open] = await Promise.all([
    prisma.creditApplication.findMany({ where: { createdAt: created }, select: { status: true } }),
    prisma.creditLoan.findMany({ where: { disbursedAt: created }, select: { principalPaise: true, repaidPaise: true } }),
    prisma.creditLoan.findMany({ where: { status: { in: ["active", "overdue"] } } }),
  ]);
  const has = (...s: string[]) => apps.filter((a) => s.includes(a.status)).length;
  return {
    applications: apps.length, offered: has("offered", "accepted", "disbursed"), accepted: has("accepted", "disbursed"), rejected: has("rejected"),
    disbursedLoans: loans.length, disbursedPaise: loans.reduce((a, l) => a + num(l.principalPaise), 0), repaidPaise: loans.reduce((a, l) => a + num(l.repaidPaise), 0),
    outstandingPaise: open.reduce((a, l) => a + outstandingOf(l), 0), overdueLoans: open.filter((l) => l.status === "overdue").length,
  };
}

// ---- FLDG (first-loss default guarantee) tracking. Read-only: no automatic payments. ----------------------------------------

export interface FldgExposure {
  partner: string;
  capBps: number;
  originatedPaise: number;
  capPaise: number;
  /** outstanding on >= 90 DPD loans plus written-off amounts: what the guarantee could be called for */
  defaultedPaise: number;
  exposurePaise: number;
  headroomPaise: number;
  utilisation: number;
}

/** Pure exposure: min(cap, defaulted). */
export function fldgFor(partner: string, capBps: number, originatedPaise: number, defaultedPaise: number): FldgExposure {
  const capPaise = Math.floor((originatedPaise * capBps) / 10_000);
  const exposurePaise = Math.min(capPaise, defaultedPaise);
  return { partner, capBps, originatedPaise, capPaise, defaultedPaise, exposurePaise, headroomPaise: capPaise - exposurePaise, utilisation: capPaise > 0 ? exposurePaise / capPaise : 0 };
}

export async function fldgExposure(): Promise<FldgExposure[]> {
  const loans = await prisma.creditLoan.findMany({ where: { status: { not: "cancelled" } } });
  const capBps = creditConfig().fldgCapBps;
  const partners = [...new Set(loans.map((l) => l.partner))];
  return partners.map((p) => {
    const ls = loans.filter((l) => l.partner === p);
    const originated = ls.reduce((a, l) => a + num(l.principalPaise), 0);
    const defaulted = ls.reduce((a, l) => a + (l.status === "written_off" ? num(l.writtenOffPaise) : (l.status === "active" || l.status === "overdue") && l.dpd >= NPA_DPD ? outstandingOf(l) : 0), 0);
    return fldgFor(p, capBps, originated, defaulted);
  });
}

// ---- staff reads (callers gate on credit.read) ------------------------------------------------------------------------------

export interface StaffApplicationView extends ApplicationView { scoreBand: string | null; score: number | null }

export async function listApplicationsForStaff(opts: { status?: string; limit?: number } = {}): Promise<StaffApplicationView[]> {
  const rows = await prisma.creditApplication.findMany({ where: opts.status ? { status: opts.status } : {}, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 200) });
  const views = await toApplicationViews(rows);
  const scores = await prisma.creditScore.findMany({ where: { id: { in: rows.map((r) => r.scoreId).filter((x): x is string => !!x) } } });
  return views.map((v, i) => {
    const s = scores.find((x) => x.id === rows[i]!.scoreId);
    return { ...v, score: s?.score ?? null, scoreBand: s?.band ?? null };
  });
}

export async function listLoansForStaff(opts: { status?: string; limit?: number } = {}): Promise<LoanView[]> {
  const rows = await prisma.creditLoan.findMany({ where: opts.status ? { status: opts.status } : {}, orderBy: [{ dpd: "desc" }, { disbursedAt: "desc" }], take: Math.min(opts.limit ?? 100, 200) });
  return rows.map((l) => toLoanView(l));
}
