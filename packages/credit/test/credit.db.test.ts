import { prisma } from "@cnote/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptOffer, applyForFinancing, computeAndStoreScore, creditPorts, declineOffer, getApplication, getBnplOption, getCreditOverview, getLatestScore, grantCreditConsent,
  handleCreditWebhook, hasActiveCreditConsent, listApplications, listLoans, listScoreHistory, recomputeAllScores, setCreditPartner, simulateMockDisbursal, withdrawCreditConsent,
  MockPartner, setCreditPorts, type CreditPartner,
} from "../src/index";
import { DAY, buyerWithEscrow, consentedActor, facts, installPorts, mkActor, mock, resetPorts, sellerWithEscrow, uid, type Fakes } from "./helpers";

let fk: Fakes;
beforeEach(() => { process.env.CREDIT_ENABLED = "1"; fk = installPorts(); });
afterEach(() => { resetPorts(); vi.restoreAllMocks(); });

const events = (type: string, id: string) => prisma.domainEvent.findMany({ where: { type, aggregateId: id } });
const acceptAll = async (actor: { personId: string; businessId: string }, appId: string) => {
  const app = await getApplication(actor, appId);
  return acceptOffer(actor, { offerId: app.offers[0]!.id, acknowledgedKfs: true, kfsVersion: "kfs-v1" });
};

describe("consent + score", () => {
  it("grant is required; scoring reads nothing without it; withdraw stops future scoring", async () => {
    const spy = vi.fn(async () => ({ trustScore: 50, badgeActive: false }));
    fk = installPorts({ trust: spy });
    const a = await mkActor();
    expect(await hasActiveCreditConsent(a.businessId)).toBe(false);
    expect(await computeAndStoreScore(a.businessId, "t")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    await grantCreditConsent(a);
    expect(await hasActiveCreditConsent(a.businessId)).toBe(true);
    const s = await computeAndStoreScore(a.businessId, "consent");
    expect(s!.score).toBeGreaterThanOrEqual(300);
    await withdrawCreditConsent(a);
    expect(await hasActiveCreditConsent(a.businessId)).toBe(false);
    spy.mockClear();
    expect(await computeAndStoreScore(a.businessId, "later")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("stores a snapshot with reasons, emits CreditScoreComputed, and dedupes identical feature vectors", async () => {
    const a = await consentedActor();
    const s1 = (await computeAndStoreScore(a.businessId, "first"))!;
    expect(s1.modelVersion).toBe("credit-v1");
    expect(s1.reasons.length).toBeGreaterThan(0);
    expect((await events("CreditScoreComputed", s1.id)).length).toBe(1);
    const s2 = (await computeAndStoreScore(a.businessId, "again"))!;
    expect(s2.id).toBe(s1.id);
    fk = installPorts({ trust: async () => ({ trustScore: 20, badgeActive: false }) });
    const s3 = (await computeAndStoreScore(a.businessId, "trust-drop"))!;
    expect(s3.id).not.toBe(s1.id);
    expect(s3.score).toBeLessThan(s1.score);
    expect((await getLatestScore(a.businessId))!.id).toBe(s3.id);
    expect((await listScoreHistory(a.businessId)).map((x) => x.id)).toEqual([s3.id, s1.id]);
    expect(await getLatestScore(uid())).toBeNull();
  });

  it("nightly recompute covers consenting businesses only and counts stored snapshots", async () => {
    const a = await consentedActor();
    const r1 = await recomputeAllScores(new Date(), 5000);
    expect(r1.businesses).toBeGreaterThan(0);
    const before = await prisma.creditScore.count({ where: { businessId: a.businessId } });
    expect(before).toBe(1);
    await recomputeAllScores(new Date(), 5000);
    expect(await prisma.creditScore.count({ where: { businessId: a.businessId } })).toBe(1);
  });

  it("a business whose identity-ledger consent was withdrawn elsewhere is not active", async () => {
    const a = await consentedActor();
    const { setConsent } = await import("@cnote/identity");
    await setConsent(a.personId, "credit_underwriting", false, "privacy_page");
    expect(await hasActiveCreditConsent(a.businessId)).toBe(false);
    await expect(applyForFinancing(a, { product: "invoice_financing", escrowId: uid() })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("invoice financing", () => {
  it("apply -> offer with KFS -> explicit accept -> disbursal webhook -> loan + assignment; repaid from escrow release", async () => {
    const { actor, escrow } = await sellerWithEscrow(fk);
    const app = await applyForFinancing(actor, { product: "invoice_financing", escrowId: escrow.escrowId });
    expect(app.status).toBe("offered");
    expect(app.offers).toHaveLength(1);
    const o = app.offers[0]!;
    expect(o.kfs).toMatchObject({ version: "kfs-v1", lenderName: expect.stringContaining("Sample NBFC"), repayment: "escrow_release", coolingOffDays: 3 });
    expect(o.totalRepayablePaise).toBe(o.amountPaise + o.interestPaise + o.processingFeePaise + o.otherFeesPaise);
    expect(app.amountPaise).toBeLessThanOrEqual(Math.floor(escrow.amountPaise * 0.97 * 0.85));
    expect((await events("CreditApplicationSubmitted", app.id)).length).toBe(1);
    expect((await events("CreditOfferReceived", app.id)).length).toBe(1);
    const share = await prisma.creditPartnerShare.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(JSON.stringify(share.fields)).not.toMatch(/gstin|email/i);

    // nothing moves without explicit acceptance
    expect((await prisma.creditLoan.count({ where: { applicationId: app.id } }))).toBe(0);
    const accepted = await acceptAll(actor, app.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.offers[0]!.status).toBe("accepted");

    const res = await simulateMockDisbursal(app.id);
    expect(res.status).toBe("processed");
    const [loan] = await listLoans(actor);
    expect(loan).toMatchObject({ product: "invoice_financing", status: "active", principalPaise: o.amountPaise, outstandingPaise: o.totalRepayablePaise, dpd: 0 });
    expect((await events("CreditDisbursed", loan!.id)).length).toBe(1);
    expect((await getApplication(actor, app.id)).status).toBe("disbursed");

    const { getPayoutAssignmentForEscrow, recordAssignmentSettlement } = await import("../src/index");
    const pa = (await getPayoutAssignmentForEscrow(escrow.escrowId))!;
    expect(pa).toMatchObject({ loanId: loan!.id, dueToPartnerPaise: o.totalRepayablePaise, partner: "mock" });
    const { onEscrowReleasedForTest } = await import("./internal");
    await onEscrowReleasedForTest(escrow.escrowId);
    expect((await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: escrow.escrowId } })).status).toBe("released");
    expect((await getPayoutAssignmentForEscrow(escrow.escrowId))!.dueToPartnerPaise).toBe(o.totalRepayablePaise);

    expect(await recordAssignmentSettlement({ assignmentId: pa.assignmentId, amountPaise: pa.dueToPartnerPaise - 100, reference: "payout-1" })).toEqual({ recorded: true });
    expect(await recordAssignmentSettlement({ assignmentId: pa.assignmentId, amountPaise: pa.dueToPartnerPaise - 100, reference: "payout-1" })).toEqual({ recorded: false });
    expect((await getPayoutAssignmentForEscrow(escrow.escrowId))!.dueToPartnerPaise).toBe(100);
    await recordAssignmentSettlement({ assignmentId: pa.assignmentId, amountPaise: 100, reference: "payout-2" });
    const closed = (await listLoans(actor))[0]!;
    expect(closed).toMatchObject({ status: "repaid", outstandingPaise: 0, repayments: expect.any(Array) });
    expect(closed.repayments.every((r) => r.source === "escrow_release")).toBe(true);
    expect(await getPayoutAssignmentForEscrow(escrow.escrowId)).toBeNull();
    expect((await events("CreditClosed", loan!.id)).length).toBe(1);
    expect((await events("CreditRepaid", loan!.id)).length).toBe(2);
    expect(await recordAssignmentSettlement({ assignmentId: uid(), amountPaise: 1, reference: "x" })).toEqual({ recorded: false });
  });

  it("refuses without an acknowledged KFS, with a stale KFS version, a stranger, or after the escrow froze", async () => {
    const { actor, escrow } = await sellerWithEscrow(fk);
    const app = await applyForFinancing(actor, { product: "invoice_financing", escrowId: escrow.escrowId });
    const offerId = app.offers[0]!.id;
    await expect(acceptOffer(actor, { offerId, acknowledgedKfs: false, kfsVersion: "kfs-v1" })).rejects.toMatchObject({ code: "validation" });
    await expect(acceptOffer(actor, { offerId, acknowledgedKfs: true, kfsVersion: "kfs-v0" })).rejects.toMatchObject({ code: "validation" });
    await expect(acceptOffer(await consentedActor(), { offerId, acknowledgedKfs: true, kfsVersion: "kfs-v1" })).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptOffer(actor, { offerId: "nope", acknowledgedKfs: true, kfsVersion: "kfs-v1" })).rejects.toMatchObject({ code: "not_found" });
    fk.escrows.set(escrow.escrowId, { ...escrow, frozen: true });
    await expect(acceptOffer(actor, { offerId, acknowledgedKfs: true, kfsVersion: "kfs-v1" })).rejects.toMatchObject({ code: "conflict" });
    fk.escrows.set(escrow.escrowId, escrow);
    await withdrawCreditConsent(actor);
    await expect(acceptOffer(actor, { offerId, acknowledgedKfs: true, kfsVersion: "kfs-v1" })).rejects.toMatchObject({ code: expect.stringMatching(/conflict|forbidden/) });
  });

  it("double accept, expired offer and decline", async () => {
    const { actor, escrow } = await sellerWithEscrow(fk);
    const app = await applyForFinancing(actor, { product: "invoice_financing", escrowId: escrow.escrowId });
    const offerId = app.offers[0]!.id;
    const settled = await Promise.allSettled([1, 2].map(() => acceptOffer(actor, { offerId, acknowledgedKfs: true, kfsVersion: "kfs-v1" })));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    await expect(declineOffer(actor, offerId)).rejects.toMatchObject({ code: "conflict" });

    const s2 = await sellerWithEscrow(fk);
    const app2 = await applyForFinancing(s2.actor, { product: "invoice_financing", escrowId: s2.escrow.escrowId });
    await prisma.creditOffer.updateMany({ where: { applicationId: app2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(acceptAll(s2.actor, app2.id)).rejects.toThrow(/expired/);

    const s3 = await sellerWithEscrow(fk);
    const app3 = await applyForFinancing(s3.actor, { product: "invoice_financing", escrowId: s3.escrow.escrowId });
    expect((await declineOffer(s3.actor, app3.offers[0]!.id)).status).toBe("declined");
    await expect(declineOffer(s3.actor, "bad")).rejects.toMatchObject({ code: "not_found" });
    await expect(declineOffer(await consentedActor(), app3.offers[0]!.id)).rejects.toMatchObject({ code: "not_found" });
    // a declined application frees the order for a new one
    expect((await applyForFinancing(s3.actor, { product: "invoice_financing", escrowId: s3.escrow.escrowId })).status).toBe("offered");
  });

  it("blocks: duplicates, ineligible orders, bad tenor/amount, unknown escrow, no consent, flag off", async () => {
    const { actor, escrow } = await sellerWithEscrow(fk);
    await applyForFinancing(actor, { product: "invoice_financing", escrowId: escrow.escrowId });
    await expect(applyForFinancing(actor, { product: "invoice_financing", escrowId: escrow.escrowId })).rejects.toThrow(/already an active/);
    const unfunded = await sellerWithEscrow(fk, { status: "awaiting_funding" });
    await expect(applyForFinancing(unfunded.actor, { product: "invoice_financing", escrowId: unfunded.escrow.escrowId })).rejects.toThrow(/not funded/i);
    const other = await sellerWithEscrow(fk);
    await expect(applyForFinancing(actor, { product: "invoice_financing", escrowId: other.escrow.escrowId })).rejects.toThrow(/not yours/);
    await expect(applyForFinancing(other.actor, { product: "invoice_financing", escrowId: other.escrow.escrowId, tenorDays: 11 })).rejects.toMatchObject({ code: "validation" });
    await expect(applyForFinancing(other.actor, { product: "invoice_financing", escrowId: other.escrow.escrowId, amountPaise: 999_999_999 })).rejects.toThrow(/above your limit/);
    await expect(applyForFinancing(other.actor, { product: "invoice_financing", escrowId: uid() })).rejects.toMatchObject({ code: "not_found" });
    await expect(applyForFinancing(other.actor, { product: "invoice_financing", escrowId: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(applyForFinancing(await mkActor(), { product: "invoice_financing", escrowId: uid() })).rejects.toMatchObject({ code: "forbidden" });
    const weak = await sellerWithEscrow(installPorts({ trust: async () => ({ trustScore: 0, badgeActive: false }), escrowHistory: async () => ({ completed: 0, completedPaise: 0, clean: 0, refunded: 0 }), gst: async () => ({ verified: false, status: null, lastCheckedAt: null, filings: [] }) }));
    await expect(applyForFinancing(weak.actor, { product: "invoice_financing", escrowId: weak.escrow.escrowId })).rejects.toThrow(/GST|score/);
    process.env.CREDIT_ENABLED = "0";
    await expect(applyForFinancing(other.actor, { product: "invoice_financing", escrowId: other.escrow.escrowId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(grantCreditConsent(other.actor)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("partner rejection and partner outage are recorded, never offered", async () => {
    const s = await sellerWithEscrow(fk);
    const rejecting = new MockPartner();
    vi.spyOn(rejecting, "submitApplication").mockResolvedValue({ partnerRef: `rej:${uid()}`, status: "rejected", offers: [], reason: "policy" });
    setCreditPartner(rejecting);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    expect(app).toMatchObject({ status: "rejected", reason: "policy", offers: [] });

    const s2 = await sellerWithEscrow(fk);
    const down = new MockPartner();
    vi.spyOn(down, "submitApplication").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setCreditPartner(down);
    await expect(applyForFinancing(s2.actor, { product: "invoice_financing", escrowId: s2.escrow.escrowId })).rejects.toThrow(/unavailable/);
    expect((await listApplications(s2.actor))[0]!.status).toBe("failed");

    const pending = new MockPartner();
    const s3 = await sellerWithEscrow(fk);
    vi.spyOn(pending, "submitApplication").mockResolvedValue({ partnerRef: `pend:${uid()}`, status: "pending", offers: [] });
    setCreditPartner(pending);
    expect((await applyForFinancing(s3.actor, { product: "invoice_financing", escrowId: s3.escrow.escrowId })).status).toBe("submitted");
  });

  it("partner acceptance failure reopens the offer", async () => {
    const s = await sellerWithEscrow(fk);
    const p = new MockPartner();
    setCreditPartner(p);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(p, "acceptOffer").mockResolvedValueOnce({ status: "failed", reason: "x" });
    await expect(acceptAll(s.actor, app.id)).rejects.toThrow(/could not confirm/);
    const again = await getApplication(s.actor, app.id);
    expect(again.status).toBe("offered");
    expect(again.offers[0]!.status).toBe("open");
    expect((await acceptAll(s.actor, app.id)).status).toBe("accepted");
  });

  it("withdrawing consent cancels un-accepted applications and withdraws open offers", async () => {
    const s = await sellerWithEscrow(fk);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    await withdrawCreditConsent(s.actor);
    const a = await getApplication(s.actor, app.id);
    expect(a).toMatchObject({ status: "cancelled", reason: "consent_withdrawn" });
    expect(a.offers[0]!.status).toBe("withdrawn");
  });

  it("overview: consent card state, score, eligible orders; empty without consent", async () => {
    const s = await sellerWithEscrow(fk);
    const o = await getCreditOverview(s.actor);
    expect(o).toMatchObject({ enabled: true, consented: true, blockers: [], lender: { name: expect.any(String) } });
    expect(o.score).not.toBeNull();
    expect(o.eligible.map((e) => e.escrowId)).toEqual([s.escrow.escrowId]);
    expect(o.eligible[0]!.maxAdvancePaise).toBeGreaterThan(0);
    await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    expect((await getCreditOverview(s.actor)).eligible[0]!.applied).toBe(true);
    const n = await getCreditOverview(await mkActor());
    expect(n).toMatchObject({ consented: false, score: null, eligible: [], applications: [] });
    const weak = installPorts({ gst: async () => ({ verified: false, status: null, lastCheckedAt: null, filings: [] }) });
    const w = await sellerWithEscrow(weak);
    expect((await getCreditOverview(w.actor)).blockers).toContain("gst_not_verified");
  });
});

describe("BNPL", () => {
  it("option -> apply -> accept -> disbursal asks escrow to record funding (idempotent retry job)", async () => {
    const { actor, escrow } = await buyerWithEscrow(fk);
    const opt = await getBnplOption(actor, escrow.escrowId);
    expect(opt).toMatchObject({ enabled: true, available: true, consented: true, application: null });
    const app = await applyForFinancing(actor, { product: "bnpl", escrowId: escrow.escrowId, tenorDays: 60 });
    expect(app.offers[0]!.kfs).toMatchObject({ repayment: "buyer_instalment", tenorDays: 60 });
    expect(app.amountPaise).toBe(escrow.amountPaise);
    expect((await getBnplOption(actor, escrow.escrowId)).application!.id).toBe(app.id);
    await acceptAll(actor, app.id);
    await simulateMockDisbursal(app.id);
    expect(fk.fund).toHaveBeenCalledWith(escrow.escrowId, app.amountPaise, expect.any(String));
    expect(await prisma.creditAssignment.count({ where: { escrowId: escrow.escrowId } })).toBe(0);

    fk.fund.mockClear();
    const { retryBnplFunding } = await import("../src/index");
    const r = await retryBnplFunding();
    expect(r.attempted).toBeGreaterThanOrEqual(1);
    expect(fk.fund).toHaveBeenCalled();
    fk.escrows.set(escrow.escrowId, { ...escrow, status: "funded" });
    fk.fund.mockClear();
    await retryBnplFunding();
    expect(fk.fund).not.toHaveBeenCalledWith(escrow.escrowId, expect.anything(), expect.anything());
  });

  it("not offered to the seller, to a funded escrow, or when disabled; funding failure is logged and retried later", async () => {
    const { actor, escrow } = await buyerWithEscrow(fk);
    expect((await getBnplOption(await consentedActor(), escrow.escrowId)).available).toBe(false);
    expect((await getBnplOption(actor, "bad")).available).toBe(false);
    expect((await getBnplOption(actor, uid())).available).toBe(false);
    const funded = await buyerWithEscrow(fk, { status: "funded" });
    expect((await getBnplOption(funded.actor, funded.escrow.escrowId)).available).toBe(false);
    const fresh = await mkActor();
    const noConsent = facts({ status: "created", buyer: fresh.businessId });
    fk.escrows.set(noConsent.escrowId, noConsent);
    expect(await getBnplOption(fresh, noConsent.escrowId)).toMatchObject({ available: true, consented: false, maxAmountPaise: noConsent.amountPaise });
    process.env.CREDIT_ENABLED = "0";
    expect((await getBnplOption(actor, escrow.escrowId)).enabled).toBe(false);
    process.env.CREDIT_ENABLED = "1";

    const b = await buyerWithEscrow(fk);
    fk.fund.mockRejectedValue(new Error("escrow down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = await applyForFinancing(b.actor, { product: "bnpl", escrowId: b.escrow.escrowId });
    await acceptAll(b.actor, app.id);
    await expect(simulateMockDisbursal(app.id)).resolves.toMatchObject({ status: "processed" });
    expect(err).toHaveBeenCalled();
    const { retryBnplFunding } = await import("../src/index");
    await expect(retryBnplFunding()).resolves.toBeTruthy();
    expect(creditPorts().sellerNetPaise(100)).toBeLessThan(100);
  });
});

describe("partner webhook", () => {
  async function disbursed() {
    const s = await sellerWithEscrow(fk);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    await acceptAll(s.actor, app.id);
    await simulateMockDisbursal(app.id);
    const row = await prisma.creditApplication.findUniqueOrThrow({ where: { id: app.id } });
    const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { applicationId: app.id } });
    return { ...s, app, row, loan };
  }
  const send = (e: Parameters<MockPartner["signedEvent"]>[0]) => { const { raw, headers } = mock().signedEvent(e); return handleCreditWebhook("mock", raw, headers); };

  it("rejects bad signatures and unknown partners; is idempotent per event id", async () => {
    const { raw } = mock().signedEvent({ eventId: "x", type: "loan.closed", partnerRef: "p" });
    await expect(handleCreditWebhook("mock", raw, new Headers())).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(handleCreditWebhook("paypal", raw, new Headers())).rejects.toMatchObject({ code: "not_found" });
    const d = await disbursed();
    const e = { eventId: `rep-${uid()}`, type: "loan.repayment" as const, partnerRef: d.row.partnerRef!, loanRef: d.loan.partnerLoanRef, amountPaise: 1000, source: "borrower" as const };
    expect(await send(e)).toEqual({ status: "processed" });
    expect(await send(e)).toEqual({ status: "duplicate" });
    // the same repayment under a NEW webhook id is also a replay of the same payment only if its key matches: distinct ids add
    expect(await send({ ...e, eventId: `rep-${uid()}` })).toEqual({ status: "processed" });
    const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { id: d.loan.id } });
    expect(Number(loan.repaidPaise)).toBe(2000);
  });

  it("repayments reduce outstanding, close the loan, and overpayment never shows negative outstanding", async () => {
    const d = await disbursed();
    const owed = Number(d.loan.totalRepayablePaise);
    await send({ eventId: uid(), type: "loan.repayment", partnerRef: d.row.partnerRef!, loanRef: d.loan.partnerLoanRef, amountPaise: owed - 10, source: "borrower" });
    expect((await listLoans(d.actor))[0]).toMatchObject({ outstandingPaise: 10, status: "active" });
    await send({ eventId: uid(), type: "loan.repayment", partnerRef: d.row.partnerRef!, loanRef: d.loan.partnerLoanRef, amountPaise: 50, source: "borrower" });
    expect((await listLoans(d.actor))[0]).toMatchObject({ outstandingPaise: 0, status: "repaid" });
    expect((await events("CreditClosed", d.loan.id)).length).toBe(1);
    const late = await send({ eventId: uid(), type: "loan.overdue", partnerRef: d.row.partnerRef!, loanRef: d.loan.partnerLoanRef, dpd: 5 });
    expect(late.status).toBe("ignored");
  });

  it("overdue reports set DPD and emit CreditOverdue on bucket crossings only", async () => {
    const d = await disbursed();
    const base = { partnerRef: d.row.partnerRef!, loanRef: d.loan.partnerLoanRef, type: "loan.overdue" as const };
    await send({ ...base, eventId: uid(), dpd: 2 });
    await send({ ...base, eventId: uid(), dpd: 7 });
    await send({ ...base, eventId: uid(), dpd: 31 });
    await send({ ...base, eventId: uid(), dpd: 3 }); // lower report never reduces
    const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { id: d.loan.id } });
    expect(loan).toMatchObject({ status: "overdue", dpd: 31, lastDpdBucket: 30 });
    expect((await events("CreditOverdue", d.loan.id)).map((x) => (x.payload as { dpd: number }).dpd)).toEqual([2, 31]);
  });

  it("partner-closed and written-off loans", async () => {
    const d = await disbursed();
    await send({ eventId: uid(), type: "loan.closed", partnerRef: d.row.partnerRef!, loanRef: d.loan.partnerLoanRef });
    expect((await listLoans(d.actor))[0]).toMatchObject({ status: "repaid", outstandingPaise: 0 });
    const w = await disbursed();
    await send({ eventId: uid(), type: "loan.written_off", partnerRef: w.row.partnerRef!, loanRef: w.loan.partnerLoanRef });
    const wl = await prisma.creditLoan.findUniqueOrThrow({ where: { id: w.loan.id } });
    expect(wl.status).toBe("written_off");
    expect(Number(wl.writtenOffPaise)).toBe(Number(w.loan.totalRepayablePaise));
    expect((await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: w.escrow.escrowId } })).status).toBe("cancelled");
    expect((await events("CreditClosed", w.loan.id)).map((x) => (x.payload as { status: string }).status)).toEqual(["written_off"]);
    expect((await send({ eventId: uid(), type: "loan.written_off", partnerRef: w.row.partnerRef!, loanRef: w.loan.partnerLoanRef })).status).toBe("processed");
    expect((await events("CreditClosed", w.loan.id)).length).toBe(1);
  });

  it("asynchronous offers / rejections from the partner; unknown refs are ignored; disbursal without acceptance is never mirrored", async () => {
    const s = await sellerWithEscrow(fk);
    const p = new MockPartner();
    vi.spyOn(p, "submitApplication").mockResolvedValue({ partnerRef: `async:${uid()}`, status: "pending", offers: [] });
    setCreditPartner(p);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    const row = await prisma.creditApplication.findUniqueOrThrow({ where: { id: app.id } });
    const offer = { offerRef: "late-1", amountPaise: 1_000_000, aprBps: 2000, tenorDays: 30, processingFeePaise: 1000, otherFeesPaise: 0 };
    const hook = (e: Partial<Parameters<MockPartner["signedEvent"]>[0]> & { type: Parameters<MockPartner["signedEvent"]>[0]["type"] }) => { const { raw, headers } = p.signedEvent({ eventId: uid(), partnerRef: row.partnerRef!, ...e }); return handleCreditWebhook("mock", raw, headers); };
    expect((await hook({ type: "loan.disbursed", loanRef: "l0" })).status).toBe("ignored");
    expect((await hook({ type: "application.offered", offers: [offer] })).status).toBe("processed");
    expect((await getApplication(s.actor, app.id))).toMatchObject({ status: "offered", offers: [expect.objectContaining({ amountPaise: 1_000_000 })] });
    expect((await hook({ type: "application.offered", offers: [offer] })).status).toBe("processed"); // same offer again: no duplicate row
    expect((await getApplication(s.actor, app.id)).offers).toHaveLength(1);
    expect((await hook({ type: "application.offered" })).status).toBe("ignored");
    expect((await hook({ type: "application.rejected", reason: "kyc_failed" })).status).toBe("processed");
    expect(await getApplication(s.actor, app.id)).toMatchObject({ status: "rejected", reason: "kyc_failed" });
    expect((await hook({ type: "application.rejected" })).status).toBe("ignored");
    expect((await hook({ type: "loan.repayment", loanRef: "missing", amountPaise: 1 })).status).toBe("ignored");
    expect((await hook({ type: "application.offered", partnerRef: "nope", offers: [offer] })).status).toBe("ignored");
    await expect(simulateMockDisbursal(app.id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("scheduled loan-book jobs", () => {
  it("DPD job flags overdue loans from due dates, emits per bucket, skips settled ones; offers expire", async () => {
    const s = await sellerWithEscrow(fk);
    const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
    await acceptAll(s.actor, app.id);
    await simulateMockDisbursal(app.id);
    const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { applicationId: app.id } });
    const { updateDpd, expireOffers, dpdOf } = await import("../src/index");
    const now = new Date(loan.dueAt.getTime() + 45 * DAY);
    expect(dpdOf(loan.dueAt, now)).toBe(45);
    const r = await updateDpd(now);
    expect(r.updated).toBeGreaterThanOrEqual(1);
    expect(await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({ dpd: 45, status: "overdue", lastDpdBucket: 30 });
    expect((await events("CreditOverdue", loan.id)).length).toBe(1);
    await updateDpd(now);
    expect((await events("CreditOverdue", loan.id)).length).toBe(1);
    await updateDpd(new Date(loan.dueAt.getTime() + 100 * DAY));
    expect((await events("CreditOverdue", loan.id)).length).toBe(2);

    const s2 = await sellerWithEscrow(fk);
    const app2 = await applyForFinancing(s2.actor, { product: "invoice_financing", escrowId: s2.escrow.escrowId });
    await prisma.creditOffer.updateMany({ where: { applicationId: app2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const ex = await expireOffers();
    expect(ex.offers).toBeGreaterThanOrEqual(1);
    expect(await getApplication(s2.actor, app2.id)).toMatchObject({ status: "expired", reason: "offer_expired" });
    expect(await expireOffers(new Date(Date.now() - 10 * DAY))).toEqual({ offers: 0, applications: 0 });
  });
});

describe("escrow assignment sync (payout-first contract)", () => {
  it("tells escrow the lender's claim at disbursal, updates it on repayment, clears it at close; escrow refusals are tolerated", async () => {
    const assigned: { escrowId: string; duePaise: number; assignmentId: string }[] = [];
    const fk = installPorts({ assignEscrowProceeds: async (i) => void assigned.push(i) });
    const { actor, escrow } = await sellerWithEscrow(fk);
    const app = await applyForFinancing(actor, { product: "invoice_financing", escrowId: escrow.escrowId });
    await acceptAll(actor, app.id);
    await simulateMockDisbursal(app.id);
    const [loan] = await listLoans(actor);
    const { syncEscrowAssignment, worker } = await import("../src/index");
    expect(await syncEscrowAssignment(loan!.id)).toBe("synced");
    expect(assigned.at(-1)).toMatchObject({ escrowId: escrow.escrowId, duePaise: loan!.outstandingPaise });
    // escrow paid the lender from the release and reported it: the handler records the repayment and re-syncs
    const a = await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: escrow.escrowId } });
    const ev = { id: 1, version: 1, aggregateType: "escrow_payout", aggregateId: "p", occurredAt: new Date().toISOString() } as const;
    await worker.handlers!.EscrowLenderRepaid!({ ...ev, type: "EscrowLenderRepaid", payload: { payoutId: uid(), escrowId: escrow.escrowId, assignmentId: a.id, amountPaise: loan!.outstandingPaise, partnerRef: "r" } });
    expect((await listLoans(actor))[0]!.status).toBe("repaid");
    await worker.handlers!.CreditClosed!({ ...ev, type: "CreditClosed", payload: { loanId: loan!.id, businessId: actor.businessId, status: "repaid" } });
    expect(assigned.at(-1)).toMatchObject({ escrowId: escrow.escrowId, duePaise: 0 });
    // escrow refuses (already paid out) -> "refused", anything else propagates; unknown loans -> "none"
    setCreditPorts({ ...fk.ports, assignEscrowProceeds: async () => { throw Object.assign(new Error("released"), { code: "conflict" }); } });
    expect(await syncEscrowAssignment(loan!.id)).toBe("refused");
    setCreditPorts({ ...fk.ports, assignEscrowProceeds: async () => { throw new Error("db down"); } });
    await expect(syncEscrowAssignment(loan!.id)).rejects.toThrow("db down");
    expect(await syncEscrowAssignment(uid())).toBe("none");
    resetPorts();
  });
});
