import fc from "fast-check";
import { prisma } from "@cnote/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  creditAttachedGmvShare, creditStats, fldgExposure, listApplicationsForStaff, listLoansForStaff, overallGnpa, partnerGnpa, purgeClosedCreditData, worker,
  computeAndStoreScore, getLatestScore, acceptOffer, applyForFinancing, simulateMockDisbursal, getApplication, handleCreditWebhook,
} from "../src/index";
import { DAY, consentedActor, installPorts, mock, resetPorts, sellerWithEscrow, uid, type Fakes } from "./helpers";
import { onEscrowRefundedForTest } from "./internal";

let fk: Fakes;
beforeEach(() => { process.env.CREDIT_ENABLED = "1"; fk = installPorts(); });
afterEach(() => { resetPorts(); vi.restoreAllMocks(); });

/** A loan row inserted directly (partner "book-<x>" so stats for it are isolated from parallel tests). */
async function loanRow(o: { partner: string; principal?: number; total?: number; repaid?: number; dpd?: number; status?: string; disbursedAt?: Date; closedAt?: Date | null; written?: number; orderAmount?: number; orderId?: string }) {
  const applicationId = uid();
  const principal = o.principal ?? 1_000_000;
  return prisma.creditLoan.create({
    data: {
      applicationId, businessId: uid(), product: "invoice_financing", escrowId: uid(), orderId: o.orderId ?? uid(), orderAmountPaise: BigInt(o.orderAmount ?? 2_000_000), partner: o.partner, partnerLoanRef: uid(),
      principalPaise: BigInt(principal), aprBps: 2000, tenorDays: 30, totalRepayablePaise: BigInt(o.total ?? principal + 10_000), repaidPaise: BigInt(o.repaid ?? 0), writtenOffPaise: BigInt(o.written ?? 0),
      disbursedAt: o.disbursedAt ?? new Date(), dueAt: new Date(Date.now() + 30 * DAY), status: o.status ?? "active", dpd: o.dpd ?? 0, closedAt: o.closedAt ?? null,
    },
  });
}

describe("metrics, FLDG and staff reads", () => {
  it("partner GNPA per partner vs the 2% target, and overall", async () => {
    const p = `book-${uid()}`;
    await loanRow({ partner: p, total: 9_000_000, principal: 9_000_000 });
    await loanRow({ partner: p, total: 100_000, principal: 100_000, dpd: 120, status: "overdue" });
    await loanRow({ partner: p, status: "repaid", repaid: 1_010_000, closedAt: new Date() });
    const g = (await partnerGnpa()).find((x) => x.partner === p)!;
    expect(g).toMatchObject({ loans: 2, gnpaPaise: 100_000, bookPaise: 9_100_000, targetRatio: 0.02 });
    expect(g.gnpaRatio).toBeCloseTo(100_000 / 9_100_000, 6);
    expect(g.withinTarget).toBe(true);
    await loanRow({ partner: p, total: 1_000_000, principal: 1_000_000, dpd: 95, status: "overdue" });
    expect((await partnerGnpa()).find((x) => x.partner === p)!.withinTarget).toBe(false);
    expect((await overallGnpa()).bookPaise).toBeGreaterThan(0);
  });

  it("FLDG exposure per partner: cap % of originated, exposure = min(cap, defaulted); written-off counts", async () => {
    vi.stubEnv("CREDIT_FLDG_CAP_BPS", "1000");
    const p = `fldg-${uid()}`;
    await loanRow({ partner: p, principal: 1_000_000, total: 1_000_000 });
    await loanRow({ partner: p, principal: 1_000_000, total: 1_000_000, dpd: 100, status: "overdue" });
    await loanRow({ partner: p, principal: 1_000_000, total: 1_000_000, status: "written_off", written: 300_000, closedAt: new Date() });
    const e = (await fldgExposure()).find((x) => x.partner === p)!;
    expect(e).toMatchObject({ capBps: 1000, originatedPaise: 3_000_000, capPaise: 300_000, defaultedPaise: 1_300_000, exposurePaise: 300_000, headroomPaise: 0, utilisation: 1 });
    vi.unstubAllEnvs();
  });

  it("credit-attached GMV counts distinct escrowed orders in range; stats summarise the book", async () => {
    const day = Math.floor(Math.random() * 14_000) * DAY; // unique historical day per run (rows persist in the test DB)
    const from = new Date(day), to = new Date(day + DAY);
    const at = (h: number) => new Date(day + h * 3_600_000);
    const order = uid();
    await loanRow({ partner: "stat-x", disbursedAt: at(5), orderId: order, orderAmount: 5_000_000 });
    await loanRow({ partner: "stat-x", disbursedAt: at(6), orderId: order, orderAmount: 5_000_000 });
    await loanRow({ partner: "stat-x", disbursedAt: at(7), orderAmount: 1_000_000 });
    const share = await creditAttachedGmvShare({ from, to });
    expect(share).toMatchObject({ attachedOrders: 2, attachedGmvPaise: 6_000_000, targetShare: 0.15 });
    expect(share.share).toBeGreaterThanOrEqual(0);
    expect(typeof share.meetsTarget).toBe("boolean");
    const st = await creditStats({ from, to });
    expect(st).toMatchObject({ disbursedLoans: 3, disbursedPaise: 3_000_000, applications: 0 });
    expect((await creditStats({ from: new Date(day - 3 * DAY), to: new Date(day - 2 * DAY) })).disbursedLoans).toBe(0);
  });

  it("staff lists applications with score and loans by DPD", async () => {
    const s = await sellerWithEscrow(fk);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    const rows = await listApplicationsForStaff({ status: "offered", limit: 500 });
    const mine = rows.find((r) => r.id === app.id)!;
    expect(mine.score).toBeGreaterThanOrEqual(300);
    expect(mine.scoreBand).toBeTruthy();
    expect((await listApplicationsForStaff()).length).toBeGreaterThan(0);
    const l = await loanRow({ partner: "staff-x", dpd: 200, status: "overdue" });
    const loans = await listLoansForStaff({ status: "overdue", limit: 200 });
    expect(loans.some((x) => x.id === l.id)).toBe(true);
    expect((await listLoansForStaff()).length).toBeGreaterThan(0);
  });
});

describe("retention (DPDP)", () => {
  it("purges closed loans and terminal applications older than the cutoff; keeps open loans and the latest score", async () => {
    const old = new Date(Date.now() - 800 * DAY);
    const s = await sellerWithEscrow(fk);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    await acceptOffer(s.actor, { offerId: app.offers[0]!.id, acknowledgedKfs: true, kfsVersion: "kfs-v1" });
    await simulateMockDisbursal(app.id);
    const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { applicationId: app.id } });
    const row = await prisma.creditApplication.findUniqueOrThrow({ where: { id: app.id } });
    const { raw, headers } = mock().signedEvent({ eventId: uid(), type: "loan.closed", partnerRef: row.partnerRef!, loanRef: loan.partnerLoanRef, at: old });
    await handleCreditWebhook("mock", raw, headers);
    expect((await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("repaid");
    // an older score snapshot and a newer one
    await prisma.creditScore.create({ data: { businessId: s.actor.businessId, score: 400, band: "poor", modelVersion: "credit-v1", reasons: [], features: {}, featureHash: uid(), trigger: "old", computedAt: old } });
    await computeAndStoreScore(s.actor.businessId, "recent");
    const open = await loanRow({ partner: "ret-open" });
    const cutoff = new Date(Date.now() - 365 * DAY);
    const r = await purgeClosedCreditData(cutoff);
    expect(r.loans).toBeGreaterThanOrEqual(1);
    expect(r.repayments).toBeGreaterThanOrEqual(1);
    expect(r.assignments).toBeGreaterThanOrEqual(1);
    expect(r.applications).toBeGreaterThanOrEqual(1);
    expect(r.offers).toBeGreaterThanOrEqual(1);
    expect(r.shares).toBeGreaterThanOrEqual(1);
    expect(r.scores).toBeGreaterThanOrEqual(1);
    expect(await prisma.creditLoan.findUnique({ where: { id: loan.id } })).toBeNull();
    expect(await prisma.creditApplication.findUnique({ where: { id: app.id } })).toBeNull();
    expect(await prisma.creditLoan.findUnique({ where: { id: open.id } })).not.toBeNull();
    expect((await getLatestScore(s.actor.businessId))!.trigger).not.toBe("old");
    expect(await prisma.creditScore.count({ where: { businessId: s.actor.businessId, trigger: "old" } })).toBe(0);
  });
});

describe("worker", () => {
  const ev = <T,>(payload: T) => ({ id: 1, type: "X", version: 1, aggregateType: "a", aggregateId: "b", payload, occurredAt: new Date().toISOString() }) as never;

  it("score recompute handlers run only when enabled and consented; escrow events update the assignment", async () => {
    const a = await consentedActor();
    const h = worker.handlers;
    await h.BusinessVerified!(ev({ businessId: a.businessId, tier: 1, kind: "gstin" }));
    const first = await getLatestScore(a.businessId);
    expect(first?.trigger).toBe("BusinessVerified");
    fk = installPorts({ trust: async () => ({ trustScore: 10, badgeActive: false }) });
    await h.TrustScoreChanged!(ev({ businessId: a.businessId, from: 80, to: 10, badgeActive: false }));
    expect((await getLatestScore(a.businessId))!.trigger).toBe("TrustScoreChanged");
    fk = installPorts({ trust: async () => ({ trustScore: 5, badgeActive: false }) });
    await h.DisputeResolved!(ev({ disputeId: uid(), orderId: uid(), outcome: "buyer_favour", refundPaise: 1, releasePaise: 0, decidedBy: "auto", faultBusinessId: a.businessId }));
    expect((await getLatestScore(a.businessId))!.trigger).toBe("DisputeResolved");
    fk = installPorts({ trust: async () => ({ trustScore: 3, badgeActive: false }) });
    await h.EscrowReleased!(ev({ escrowId: uid(), orderId: uid(), sellerBusinessId: a.businessId, amountPaise: 1, feePaise: 0, cause: "auto_release" }));
    expect((await getLatestScore(a.businessId))!.trigger).toBe("EscrowReleased");
    fk = installPorts({ trust: async () => ({ trustScore: 2, badgeActive: false }) });
    await h.EscrowRefunded!(ev({ escrowId: uid(), orderId: uid(), buyerBusinessId: a.businessId, amountPaise: 1, cause: "staff" }));
    expect((await getLatestScore(a.businessId))!.trigger).toBe("EscrowRefunded");

    const count = await prisma.creditScore.count({ where: { businessId: a.businessId } });
    process.env.CREDIT_ENABLED = "0";
    fk = installPorts({ trust: async () => ({ trustScore: 99, badgeActive: true }) });
    await h.BusinessVerified!(ev({ businessId: a.businessId, tier: 1, kind: "gstin" }));
    await h.DisputeResolved!(ev({ disputeId: uid(), orderId: uid(), outcome: "withdrawn", refundPaise: 0, releasePaise: 0, decidedBy: "auto", faultBusinessId: null }));
    expect(await prisma.creditScore.count({ where: { businessId: a.businessId } })).toBe(count);
  });

  it("EscrowReleased marks the assignment; a full refund cancels it, a partial one does not", async () => {
    const s = await sellerWithEscrow(fk);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    await acceptOffer(s.actor, { offerId: app.offers[0]!.id, acknowledgedKfs: true, kfsVersion: "kfs-v1" });
    await simulateMockDisbursal(app.id);
    await onEscrowRefundedForTest(s.escrow.escrowId);
    expect((await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: s.escrow.escrowId } })).status).toBe("active");
    fk.escrows.set(s.escrow.escrowId, { ...s.escrow, status: "refunded" });
    await worker.handlers.EscrowRefunded!(ev({ escrowId: s.escrow.escrowId, orderId: s.escrow.orderId, buyerBusinessId: uid(), amountPaise: 1, cause: "cancelled" }));
    expect((await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: s.escrow.escrowId } })).status).toBe("cancelled");
    expect((await getApplication(s.actor, app.id)).loan).not.toBeNull();

    const s2 = await sellerWithEscrow(fk);
    const app2 = await applyForFinancing(s2.actor, { product: "invoice_financing", escrowId: s2.escrow.escrowId });
    await acceptOffer(s2.actor, { offerId: app2.offers[0]!.id, acknowledgedKfs: true, kfsVersion: "kfs-v1" });
    await simulateMockDisbursal(app2.id);
    await worker.handlers.EscrowReleased!(ev({ escrowId: s2.escrow.escrowId, orderId: s2.escrow.orderId, sellerBusinessId: s2.actor.businessId, amountPaise: 1, feePaise: 0, cause: "buyer_accepted" }));
    expect((await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: s2.escrow.escrowId } })).status).toBe("released");
  });

  it("jobs are registered and runnable", async () => {
    expect(worker.name).toBe("credit");
    expect(worker.jobs.map((j) => j.name).sort()).toEqual(["credit.bnpl-funding", "credit.expire-offers", "credit.nightly-scores", "credit.update-dpd"]);
    for (const j of worker.jobs) await j.run();
    process.env.CREDIT_ENABLED = "0";
    await worker.jobs.find((j) => j.name === "credit.nightly-scores")!.run();
  });
});

describe("repayment ledger properties", () => {
  it("repaid = sum of distinct repayments; outstanding never negative; replays are no-ops; closes exactly when settled", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 400_000 }), { minLength: 1, maxLength: 8 }), fc.boolean(), async (amounts, replay) => {
      const p = `prop-${uid()}`;
      const loan = await loanRow({ partner: p, principal: 1_000_000, total: 1_000_000 });
      const partnerRef = uid();
      await prisma.creditApplication.create({ data: { id: loan.applicationId, businessId: loan.businessId, product: "invoice_financing", escrowId: loan.escrowId, orderId: loan.orderId, orderAmountPaise: 1n, amountPaise: 1n, tenorDays: 30, partner: p, partnerRef, status: "disbursed" } });
      const send = (key: string, amt: number) => { const { raw, headers } = mock().signedEvent({ eventId: `${key}`, type: "loan.repayment", partnerRef, loanRef: loan.partnerLoanRef, amountPaise: amt, source: "borrower" }); return handleCreditWebhook("mock", raw, headers); };
      // partner "mock" is required to verify signatures, but the loan row belongs to partner p: use the recordRepayment path through mock partner name
      await prisma.creditLoan.update({ where: { id: loan.id }, data: { partner: "mock" } });
      await prisma.creditApplication.update({ where: { id: loan.applicationId }, data: { partner: "mock" } });
      let i = 0;
      for (const a of amounts) { await send(`${p}-${i}`, a); if (replay) await send(`${p}-${i}`, a); i += 1; }
      const l = await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } });
      const sum = amounts.reduce((x, y) => x + y, 0);
      expect(Number(l.repaidPaise)).toBe(sum);
      const reps = await prisma.creditRepayment.findMany({ where: { loanId: loan.id } });
      expect(reps.reduce((x, r) => x + Number(r.amountPaise), 0)).toBe(sum);
      expect(reps).toHaveLength(amounts.length);
      expect(l.status).toBe(sum >= 1_000_000 ? "repaid" : "active");
      const view = (await listLoansForStaff({ limit: 200 })).find((x) => x.id === loan.id);
      if (view) expect(view.outstandingPaise).toBe(Math.max(0, 1_000_000 - sum));
    }), { numRuns: 12 });
  });
});
