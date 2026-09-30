import { prisma } from "@cnote/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptOffer, applyForFinancing, cancelLoanInCoolingOff, coolingOffQuotesFor, getApplication, getBnplOption, getCoolingOffQuote, getCreditOverview, handleCreditWebhook, interestPaise, listLoans,
  MockPartner, computeGnpa, purgeClosedCreditData, setCreditPartner, setCreditPorts, simulateMockDisbursal, worker, type CreditPartner,
} from "../src/index";
import { DAY, buyerWithEscrow, consentedActor, installPorts, mock, resetPorts, sellerWithEscrow, uid, type Fakes } from "./helpers";

let fk: Fakes;
beforeEach(() => { process.env.CREDIT_ENABLED = "1"; delete process.env.CREDIT_COOLING_OFF_WAIVES_FEES; delete process.env.CREDIT_COOLING_OFF_DAYS; fk = installPorts(); });
afterEach(() => { resetPorts(); vi.restoreAllMocks(); });

const events = (type: string, id: string) => prisma.domainEvent.findMany({ where: { type, aggregateId: id } });
type A = { personId: string; businessId: string };
async function accept(actor: A, appId: string) {
  const app = await getApplication(actor, appId);
  return acceptOffer(actor, { offerId: app.offers[0]!.id, acknowledgedKfs: true, kfsVersion: "kfs-v1" });
}
async function financedLoan() {
  const s = await sellerWithEscrow(fk);
  const app = await applyForFinancing(s.actor, { product: "invoice_financing", escrowId: s.escrow.escrowId });
  await accept(s.actor, app.id);
  await simulateMockDisbursal(app.id);
  const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { applicationId: app.id } });
  return { ...s, app, loan };
}
const ageLoan = (id: string, days: number) => prisma.creditLoan.update({ where: { id }, data: { disbursedAt: new Date(Date.now() - days * DAY) } });

describe("cooling-off exit", () => {
  it("quotes the exact amount, requires the confirmed amount, calls the partner, closes the mirror as cancelled and clears escrow's claim", async () => {
    const assigned: { escrowId: string; duePaise: number }[] = [];
    fk = installPorts({ assignEscrowProceeds: async (i) => void assigned.push(i) });
    const { actor, loan, app, escrow } = await financedLoan();
    await ageLoan(loan.id, 1.5);
    const offer = (await getApplication(actor, app.id)).offers[0]!;
    const q = await getCoolingOffQuote(actor, loan.id);
    expect(q).toMatchObject({ eligible: true, blocked: null, coolingOffDays: 3, interestDays: 2, principalPaise: Number(loan.principalPaise), feesWaived: false });
    expect(q.interestPaise).toBe(interestPaise(Number(loan.principalPaise), loan.aprBps, 2));
    expect(q.feesPaise).toBe(offer.processingFeePaise + offer.otherFeesPaise); // no fee refund by default
    expect(q.payablePaise).toBe(q.principalPaise + q.interestPaise + q.feesPaise);
    expect(q.payablePaise).toBeLessThan(offer.totalRepayablePaise);

    const cancel = vi.spyOn(mock(), "cancel");
    await expect(cancelLoanInCoolingOff(actor, { loanId: loan.id, confirmExit: false, expectedPayablePaise: q.payablePaise })).rejects.toMatchObject({ code: "validation" });
    await expect(cancelLoanInCoolingOff(actor, { loanId: loan.id, confirmExit: true, expectedPayablePaise: q.payablePaise - 1 })).rejects.toMatchObject({ code: "validation" });
    await expect(cancelLoanInCoolingOff(await consentedActor(), { loanId: loan.id, confirmExit: true, expectedPayablePaise: q.payablePaise })).rejects.toMatchObject({ code: "not_found" });
    expect(cancel).not.toHaveBeenCalled();
    expect((await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("active");

    const out = await cancelLoanInCoolingOff(actor, { loanId: loan.id, confirmExit: true, expectedPayablePaise: q.payablePaise });
    expect(cancel).toHaveBeenCalledWith(loan.partnerLoanRef, "cooling_off");
    expect(out.payablePaise).toBe(q.payablePaise);
    expect(out.loan).toMatchObject({ status: "cancelled", outstandingPaise: 0, exitAmountPaise: q.payablePaise, cancelReason: "cooling_off" });
    expect(out.loan.closedAt).not.toBeNull();
    expect(await getApplication(actor, app.id)).toMatchObject({ status: "cancelled", reason: "cooling_off_exit" });
    expect((await prisma.creditAssignment.findUniqueOrThrow({ where: { escrowId: escrow.escrowId } })).status).toBe("cancelled");
    expect(assigned.at(-1)).toMatchObject({ escrowId: escrow.escrowId, duePaise: 0 });
    const ev = await events("CreditCancelled", loan.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ loanId: loan.id, applicationId: app.id, businessId: actor.businessId, reason: "cooling_off" });
    // idempotent for the same borrower
    expect((await cancelLoanInCoolingOff(actor, { loanId: loan.id, confirmExit: true, expectedPayablePaise: 0 })).payablePaise).toBe(q.payablePaise);
    expect(await events("CreditCancelled", loan.id)).toHaveLength(1);
    // the escrow can be financed again, and the exit is not in the loan book
    expect((await listLoans(actor))[0]).toMatchObject({ status: "cancelled" });
    await getCreditOverview(actor);
  });

  it("is refused after the window, on a closed loan, and while escrow is settling the loan; partner failure changes nothing", async () => {
    const { actor, loan } = await financedLoan();
    const cancelBody = async (payable?: number) => cancelLoanInCoolingOff(actor, { loanId: loan.id, confirmExit: true, expectedPayablePaise: payable ?? (await getCoolingOffQuote(actor, loan.id)).payablePaise });

    // partner refuses / errors: nothing changes
    const spy = vi.spyOn(mock(), "cancel").mockResolvedValueOnce({ status: "failed", reason: "nope" });
    await expect(cancelBody()).rejects.toMatchObject({ code: "conflict" });
    spy.mockRejectedValueOnce(new Error("timeout"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(cancelBody()).rejects.toMatchObject({ code: "conflict" });
    expect(err).toHaveBeenCalled();
    expect((await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("active");
    expect(await events("CreditCancelled", loan.id)).toHaveLength(0);
    spy.mockRestore();

    // escrow already released: the lender is being paid from it
    await prisma.creditAssignment.updateMany({ where: { loanId: loan.id }, data: { status: "released" } });
    expect(await getCoolingOffQuote(actor, loan.id)).toMatchObject({ eligible: false, blocked: "escrow_settling" });
    await expect(cancelBody(1)).rejects.toMatchObject({ code: "conflict" });
    await prisma.creditAssignment.updateMany({ where: { loanId: loan.id }, data: { status: "active" } });

    // window over
    await ageLoan(loan.id, 4);
    expect(await getCoolingOffQuote(actor, loan.id)).toMatchObject({ eligible: false, blocked: "window_over" });
    expect(await coolingOffQuotesFor(actor, [loan])).toEqual({});
    await expect(cancelBody(1)).rejects.toMatchObject({ code: "conflict" });
    process.env.CREDIT_COOLING_OFF_DAYS = "7";
    expect((await getCoolingOffQuote(actor, loan.id)).eligible).toBe(true);

    // closed loan
    await prisma.creditLoan.update({ where: { id: loan.id }, data: { status: "repaid" } });
    expect(await getCoolingOffQuote(actor, loan.id)).toMatchObject({ eligible: false, blocked: "loan_closed" });
    await expect(cancelBody(1)).rejects.toMatchObject({ code: "conflict" });
    await expect(getCoolingOffQuote(actor, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("config can waive the fees; the exit works even with CREDIT_ENABLED off", async () => {
    const { actor, loan } = await financedLoan();
    const withFees = await getCoolingOffQuote(actor, loan.id);
    process.env.CREDIT_COOLING_OFF_WAIVES_FEES = "1";
    const waived = await getCoolingOffQuote(actor, loan.id);
    expect(waived).toMatchObject({ feesPaise: 0, feesWaived: true });
    expect(waived.payablePaise).toBe(withFees.payablePaise - withFees.feesPaise);
    process.env.CREDIT_ENABLED = "0";
    await cancelLoanInCoolingOff(actor, { loanId: loan.id, confirmExit: true, expectedPayablePaise: waived.payablePaise });
    expect((await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("cancelled");
  });

  it("the portal overview and the BNPL option carry the exit quote; the stub partner is not configured", async () => {
    const s = await financedLoan();
    const ov = await getCreditOverview(s.actor);
    expect(ov.exitQuotes[s.loan.id]).toMatchObject({ eligible: true, loanId: s.loan.id });

    const b = await buyerWithEscrow(fk);
    const app = await applyForFinancing(b.actor, { product: "bnpl", escrowId: b.escrow.escrowId });
    await accept(b.actor, app.id);
    await simulateMockDisbursal(app.id);
    const opt = await getBnplOption(b.actor, b.escrow.escrowId);
    expect(opt.exitQuote).toMatchObject({ eligible: true, product: "bnpl" });
    const loan = await prisma.creditLoan.findUniqueOrThrow({ where: { applicationId: app.id } });
    await cancelLoanInCoolingOff(b.actor, { loanId: loan.id, confirmExit: true, expectedPayablePaise: opt.exitQuote!.payablePaise });
    expect((await getBnplOption(b.actor, b.escrow.escrowId)).exitQuote).toBeNull();
    expect(await coolingOffQuotesFor(b.actor, [])).toEqual({});

    const { NbfcPartnerStub } = await import("../src/index");
    expect(() => new NbfcPartnerStub().cancel()).toThrow("not configured");
    expect(await mock().cancel("fail:x", "cooling_off")).toMatchObject({ status: "failed" });
  });

  it("a partner-initiated cancellation arrives by signed webhook; cancelled loans leave the book, GNPA and retention treat them as closed", async () => {
    const { actor, loan, app, row } = await (async () => { const f = await financedLoan(); return { ...f, row: await prisma.creditApplication.findUniqueOrThrow({ where: { id: f.app.id } }) }; })();
    void app;
    const send = (o: Parameters<MockPartner["signedEvent"]>[0]) => { const { raw, headers } = mock().signedEvent(o); return handleCreditWebhook("mock", raw, headers); };
    expect(await send({ eventId: `c-${uid()}`, type: "loan.cancelled", partnerRef: row.partnerRef!, loanRef: loan.partnerLoanRef, amountPaise: 12345 })).toEqual({ status: "processed" });
    const l = await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(l).toMatchObject({ status: "cancelled", cancelReason: "partner", exitAmountPaise: 12345n });
    expect((await events("CreditCancelled", loan.id))[0]!.payload).toMatchObject({ reason: "partner" });
    // later partner noise on a cancelled loan is ignored
    expect((await send({ eventId: `o-${uid()}`, type: "loan.overdue", partnerRef: row.partnerRef!, loanRef: loan.partnerLoanRef, dpd: 95 })).status).toBe("ignored");
    expect((await send({ eventId: `x-${uid()}`, type: "loan.closed", partnerRef: row.partnerRef!, loanRef: loan.partnerLoanRef })).status).toBe("ignored");
    expect((await send({ eventId: `y-${uid()}`, type: "loan.cancelled", partnerRef: row.partnerRef!, loanRef: loan.partnerLoanRef })).status).toBe("ignored");
    expect((await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } })).dpd).toBe(0);
    // Scoped to THIS loan (overallGnpa() spans the shared test DB, where parallel files keep adding loans): a cancelled loan
    // contributes nothing to the book or the NPA figure, whatever its DPD.
    const mirror = await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(computeGnpa([{ outstandingPaise: 5_000_000, dpd: 120, status: mirror.status, writtenOffPaise: 0 }])).toEqual({ gnpaRatio: 0, gnpaPaise: 0, bookPaise: 0 });
    // the worker handler keeps escrow in step
    const seen: number[] = [];
    setCreditPorts({ ...fk.ports, assignEscrowProceeds: async (i) => void seen.push(i.duePaise) });
    await worker.handlers!.CreditCancelled!({ id: 1, version: 1, type: "CreditCancelled", aggregateType: "credit_loan", aggregateId: loan.id, occurredAt: new Date().toISOString(), payload: { loanId: loan.id, applicationId: l.applicationId, businessId: actor.businessId, reason: "partner" } });
    expect(seen).toEqual([0]);
    // DPDP retention purges cancelled loans once closed before the cutoff. Backdate THIS loan and purge with a cutoff in the
    // past: a future cutoff would also purge loans that parallel test files just closed and are still asserting on.
    await prisma.creditLoan.update({ where: { id: loan.id }, data: { closedAt: new Date(Date.now() - 800 * DAY) } });
    const r = await purgeClosedCreditData(new Date(Date.now() - 365 * DAY));
    expect(r.loans).toBeGreaterThanOrEqual(1);
    expect(await prisma.creditLoan.findUnique({ where: { id: loan.id } })).toBeNull();
  });
});

// keep the type imported for custom partners in other suites
export type { CreditPartner };
void setCreditPartner; void uid;
