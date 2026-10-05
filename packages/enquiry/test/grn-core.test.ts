import { describe, expect, it } from "vitest";
import {
  assertReturnAction, canReturnAct, checkCreditAmounts, checkReceiptDate, checkReceiptLine, checkReceiverName, formatDocNumber, isRejectReason, isReturnReason, maxReceivable,
  normaliseCreditNoteNumber, returnableQty, returnDaysLeft, returnDeadline, returnWindowDays, returnWindowOpen,
} from "../src/grn-core";
import { defaultTolerances, evaluateMatch, paymentGate, worst, type MatchInput, type MatchInvoiceIn } from "../src/match-core";

describe("receipt lines", () => {
  it("derives accepted from received and rejected", () => {
    expect(checkReceiptLine({ poLineNo: 1, receivedQty: 100, rejectedQty: 10, rejectReason: "damaged" })).toMatchObject({ acceptedQty: 90, rejectedQty: 10, rejectReason: "damaged" });
    expect(checkReceiptLine({ poLineNo: 1, receivedQty: 100 })).toMatchObject({ acceptedQty: 100, rejectedQty: 0, rejectReason: null });
    expect(checkReceiptLine({ poLineNo: 1, receivedQty: 100, acceptedQty: 95, rejectReason: "short" })).toMatchObject({ acceptedQty: 95, rejectedQty: 5 });
  });
  it("rejects inconsistent or unsafe input", () => {
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: 100, acceptedQty: 90, rejectedQty: 5, rejectReason: "damaged" })).toThrow(/must equal received/);
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: 10, rejectedQty: 11, rejectReason: "damaged" })).toThrow(/more than/);
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: 10, rejectedQty: 1 })).toThrow(/reason/);
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: 10, rejectedQty: 1, rejectReason: "lost" })).toThrow(/reason/);
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: 1.5 })).toThrow();
    expect(() => checkReceiptLine({ poLineNo: 0, receivedQty: 1 })).toThrow();
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: -1 })).toThrow();
    expect(() => checkReceiptLine({ poLineNo: 1, receivedQty: 5, rejectedQty: 1, rejectReason: "damaged", rejectNote: "x".repeat(301) })).toThrow(/300/);
  });
  it("keeps the note only when something is rejected", () => {
    expect(checkReceiptLine({ poLineNo: 1, receivedQty: 5, rejectNote: "ignored" }).rejectNote).toBeNull();
    expect(checkReceiptLine({ poLineNo: 1, receivedQty: 5, rejectedQty: 1, rejectReason: "damaged", rejectNote: " torn " }).rejectNote).toBe("torn");
  });
  it("caps over-delivery at the quantity tolerance", () => {
    expect(maxReceivable(100, 0, 200)).toBe(102);
    expect(maxReceivable(100, 60, 0)).toBe(40);
    expect(maxReceivable(100, 150, 0)).toBe(0);
  });
  it("validates date and receiver", () => {
    expect(checkReceiptDate("2026-10-05", "2026-10-06")).toBe("2026-10-05");
    expect(() => checkReceiptDate("2026-10-07", "2026-10-06")).toThrow(/future/);
    expect(() => checkReceiptDate("2026-01-01", "2026-10-06")).toThrow(/days ago/);
    expect(() => checkReceiptDate("nope", "2026-10-06")).toThrow();
    expect(() => checkReceiptDate(null, "2026-10-06")).toThrow();
    expect(checkReceiverName(" Ravi K ")).toBe("Ravi K");
    expect(() => checkReceiverName("R")).toThrow();
  });
  it("formats document numbers and reason codes", () => {
    expect(formatDocNumber("grn", "2026-27", 4)).toBe("GRN/26-27/000004");
    expect(formatDocNumber("rma", "2026-27", 12)).toBe("RMA/26-27/000012");
    expect(isRejectReason("damaged")).toBe(true);
    expect(isRejectReason("other")).toBe(false);
    expect(isReturnReason("other")).toBe(true);
    expect(isReturnReason(3)).toBe(false);
  });
});

describe("returns", () => {
  it("window defaults and bounds", () => {
    expect(returnWindowDays({})).toBe(30);
    expect(returnWindowDays({ RETURN_WINDOW_DAYS: "14" } as NodeJS.ProcessEnv)).toBe(14);
    expect(returnWindowDays({ RETURN_WINDOW_DAYS: "0" } as NodeJS.ProcessEnv)).toBe(30);
    expect(returnWindowDays({ RETURN_WINDOW_DAYS: "9999" } as NodeJS.ProcessEnv)).toBe(30);
    expect(returnDeadline("2026-10-01", 30)).toBe("2026-10-31");
    expect(returnWindowOpen("2026-10-01", "2026-10-31", 30)).toBe(true);
    expect(returnWindowOpen("2026-10-01", "2026-11-01", 30)).toBe(false);
    expect(returnDaysLeft("2026-10-01", "2026-10-29", 30)).toBe(2);
  });
  it("state machine by role", () => {
    expect(canReturnAct("requested", "approve", "seller")).toBe(true);
    expect(canReturnAct("requested", "approve", "buyer")).toBe(false);
    expect(canReturnAct("requested", "cancel", "buyer")).toBe(true);
    expect(canReturnAct("approved", "cancel", "buyer")).toBe(false);
    expect(canReturnAct("approved", "ship", "buyer")).toBe(true);
    expect(canReturnAct("shipped", "receive", "seller")).toBe(true);
    expect(canReturnAct("received", "credit", "seller")).toBe(true);
    expect(canReturnAct("credited", "credit", "seller")).toBe(false);
    expect(canReturnAct("rejected", "dispute", "buyer")).toBe(true);
    expect(assertReturnAction("requested", "approve", "seller")).toBe("approved");
    expect(assertReturnAction("rejected", "dispute", "buyer")).toBeNull();
    expect(() => assertReturnAction("requested", "approve", "buyer")).toThrow(/Only the seller/);
    expect(() => assertReturnAction("rejected", "ship", "buyer")).toThrow(/marked shipped/);
    expect(() => assertReturnAction("shipped", "reject", "seller")).toThrow(/rejected/);
  });
  it("returnable quantities", () => {
    expect(returnableQty({ acceptedQty: 90, rejectedQty: 10 }, "rejected", 4)).toBe(6);
    expect(returnableQty({ acceptedQty: 90, rejectedQty: 10 }, "accepted", 100)).toBe(0);
  });
  it("credit note amounts and numbers", () => {
    expect(checkCreditAmounts(1000, 180)).toBe(1180);
    expect(() => checkCreditAmounts(0, 0)).toThrow();
    expect(() => checkCreditAmounts(-1, 5)).toThrow();
    expect(() => checkCreditAmounts(1.5, 5)).toThrow();
    expect(normaliseCreditNoteNumber(" cn/26-27/001 ")).toBe("CN/26-27/001");
    expect(() => normaliseCreditNoteNumber("CN 001")).toThrow();
  });
});

const poLines = [{ lineNo: 1, description: "Box A", unit: "pcs", quantity: 100, unitPricePaise: 10_000 }, { lineNo: 2, description: "Box B", unit: "pcs", quantity: 50, unitPricePaise: 20_000 }];
const inv = (over: Partial<MatchInvoiceIn> & { id: string }): MatchInvoiceIn => ({ number: over.id, taxablePaise: 0, lines: null, creditedRejectedQty: [], creditedRejectedTaxablePaise: 0, ...over });
const base = (over: Partial<MatchInput>): MatchInput => ({ poLines, accepted: new Map([[1, 100], [2, 50]]), receiptCount: 1, invoices: [], tolerances: { qtyBps: 200, priceBps: 100 }, ...over });

describe("three-way match", () => {
  it("defaults come from env with sane fallbacks", () => {
    expect(defaultTolerances({})).toEqual({ qtyBps: 200, priceBps: 100 });
    expect(defaultTolerances({ MATCH_DEFAULT_QTY_TOLERANCE_BPS: "0", MATCH_DEFAULT_PRICE_TOLERANCE_BPS: "50" } as NodeJS.ProcessEnv)).toEqual({ qtyBps: 0, priceBps: 50 });
    expect(defaultTolerances({ MATCH_DEFAULT_QTY_TOLERANCE_BPS: "99999", MATCH_DEFAULT_PRICE_TOLERANCE_BPS: "x" } as NodeJS.ProcessEnv)).toEqual({ qtyBps: 200, priceBps: 100 });
    expect(worst("matched", "mismatch", "pending_grn")).toBe("mismatch");
  });

  it("line match: exact, within tolerance, mismatch", () => {
    const exact = evaluateMatch(base({ invoices: [inv({ id: "a", taxablePaise: 2_000_000, lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_000 }, { poLineNo: 2, quantity: 50, unitPricePaise: 20_000 }] })] }))[0]!;
    expect(exact.status).toBe("matched");
    expect(exact.basis).toBe("line");

    // accepted 100, billed 102: exactly 2% => within; billed 103 => mismatch
    const within = evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 102, unitPricePaise: 10_000 }] })] }))[0]!;
    expect(within.lines[0]).toMatchObject({ qtyStatus: "within_tolerance", status: "within_tolerance" });
    const over = evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 103, unitPricePaise: 10_000 }] })] }))[0]!;
    expect(over.status).toBe("mismatch");

    // price 1% over => within, 2% over => mismatch, 2% under => mismatch too
    expect(evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_100 }] })] }))[0]!.lines[0]!.priceStatus).toBe("within_tolerance");
    expect(evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_200 }] })] }))[0]!.status).toBe("mismatch");
    expect(evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 9_800 }] })] }))[0]!.status).toBe("mismatch");
  });

  it("billing less than accepted is fine; billing for rejected units is a mismatch", () => {
    expect(evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 40, unitPricePaise: 10_000 }] })] }))[0]!.status).toBe("matched");
    // accepted 90 of 100 (10 rejected), seller bills all 100: 11% over
    const r = evaluateMatch(base({ accepted: new Map([[1, 90]]), invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_000 }] })] }))[0]!;
    expect(r.status).toBe("mismatch");
    expect(r.lines[0]).toMatchObject({ acceptedQty: 90, billedQty: 100, qtyStatus: "mismatch" });
  });

  it("a credited return of rejected units cures the over-billing", () => {
    const r = evaluateMatch(base({
      accepted: new Map([[1, 90]]),
      invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_000 }], creditedRejectedQty: [{ poLineNo: 1, quantity: 10 }] })],
    }))[0]!;
    expect(r.lines[0]).toMatchObject({ billedQty: 90, qtyStatus: "matched" });
    expect(r.status).toBe("matched");
  });

  it("is cumulative across invoices of the same PO", () => {
    const [a, b] = evaluateMatch(base({
      accepted: new Map([[1, 60]]),
      invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 40, unitPricePaise: 10_000 }] }), inv({ id: "b", lines: [{ poLineNo: 1, quantity: 40, unitPricePaise: 10_000 }] })],
    })) as [ReturnType<typeof evaluateMatch>[number], ReturnType<typeof evaluateMatch>[number]];
    expect(a.status).toBe("matched");
    expect(b.lines[0]).toMatchObject({ billedQty: 80, acceptedQty: 60, status: "mismatch" });
  });

  it("pending GRN when nothing was received, and mismatch for a line with no accepted units", () => {
    const p = evaluateMatch(base({ receiptCount: 0, accepted: new Map(), invoices: [inv({ id: "a", taxablePaise: 100, lines: [{ poLineNo: 1, quantity: 1, unitPricePaise: 10_000 }] }), inv({ id: "b", taxablePaise: 100 })] }));
    expect(p.map((x) => x.status)).toEqual(["pending_grn", "pending_grn"]);
    const z = evaluateMatch(base({ accepted: new Map(), invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 1, unitPricePaise: 10_000 }] })] }))[0]!;
    expect(z.status).toBe("mismatch");
  });

  it("unknown PO line on an invoice is a mismatch", () => {
    const r = evaluateMatch(base({ invoices: [inv({ id: "a", lines: [{ poLineNo: 9, quantity: 1, unitPricePaise: 1 }] })] }))[0]!;
    expect(r.status).toBe("mismatch");
    expect(r.lines[0]!.description).toBe("");
  });

  it("amount-level match when the invoice has no lines", () => {
    // accepted value = 100*10000 + 50*20000 = 2,000,000
    const m = (taxable: number, over: Partial<MatchInput> = {}) => evaluateMatch(base({ invoices: [inv({ id: "a", taxablePaise: taxable })], ...over }))[0]!;
    expect(m(2_000_000)).toMatchObject({ status: "matched", basis: "amount" });
    expect(m(1_500_000).status).toBe("matched");
    // combined tolerance = 200 + 100 + 2 = 302 bps => 2,060,400
    expect(m(2_060_400).status).toBe("within_tolerance");
    expect(m(2_060_401).status).toBe("mismatch");
    expect(m(1, { accepted: new Map(), receiptCount: 1 }).status).toBe("mismatch");
    // credited rejected value is netted off
    const net = evaluateMatch(base({ accepted: new Map([[1, 90], [2, 50]]), invoices: [inv({ id: "a", taxablePaise: 2_000_000, creditedRejectedTaxablePaise: 100_000 })] }))[0]!;
    expect(net.amount).toMatchObject({ billedPaise: 1_900_000, acceptedPaise: 1_900_000, status: "matched" });
  });

  it("fingerprint changes with the numbers; the payment gate honours overrides", () => {
    const a = evaluateMatch(base({ accepted: new Map([[1, 90]]), invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_000 }] })] }))[0]!;
    const b = evaluateMatch(base({ accepted: new Map([[1, 80]]), invoices: [inv({ id: "a", lines: [{ poLineNo: 1, quantity: 100, unitPricePaise: 10_000 }] })] }))[0]!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(paymentGate(a, { blockPendingGrn: false, overriddenFingerprints: new Set() })).toEqual({ blocked: true, reason: "mismatch" });
    expect(paymentGate(a, { blockPendingGrn: false, overriddenFingerprints: new Set([a.fingerprint]) }).blocked).toBe(false);
    expect(paymentGate(b, { blockPendingGrn: false, overriddenFingerprints: new Set([a.fingerprint]) }).blocked).toBe(true);
    const pend = evaluateMatch(base({ receiptCount: 0, accepted: new Map(), invoices: [inv({ id: "p", taxablePaise: 5 })] }))[0]!;
    expect(paymentGate(pend, { blockPendingGrn: false, overriddenFingerprints: new Set() }).blocked).toBe(false);
    expect(paymentGate(pend, { blockPendingGrn: true, overriddenFingerprints: new Set() })).toEqual({ blocked: true, reason: "pending_grn" });
    expect(paymentGate(pend, { blockPendingGrn: true, overriddenFingerprints: new Set([pend.fingerprint]) }).blocked).toBe(false);
  });
});
