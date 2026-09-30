import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "@cnote/core";
import { ACCOUNTS, accountSpec, balancesOf, validateLines } from "../src/ledger";
import { computeFee, feeBreakdown } from "../src/fee";
import { ESCROWABLE_ORDER_STATUSES, TRANSITIONS, canTransition, isTerminal, isHolding, milestoneForOrderStatus, type EscrowStatus } from "../src/state";
import { escrowConversionRate, percentile } from "../src/stats";
import { diffSums } from "../src/reconcile";

const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

describe("ledger validation", () => {
  it("accepts a balanced journal and rejects bad ones", () => {
    const ok = validateLines([{ account: ACCOUNTS.nodal, debitPaise: 100 }, { account: ACCOUNTS.escrow(U), creditPaise: 100 }]);
    expect(ok).toHaveLength(2);
    const bad = (l: Parameters<typeof validateLines>[0]) => expect(() => validateLines(l)).toThrow(DomainError);
    bad([{ account: ACCOUNTS.nodal, debitPaise: 100 }]);
    bad([{ account: ACCOUNTS.nodal, debitPaise: 100 }, { account: ACCOUNTS.escrow(U), creditPaise: 99 }]);
    bad([{ account: ACCOUNTS.nodal, debitPaise: 100, creditPaise: 100 }, { account: ACCOUNTS.escrow(U), creditPaise: 0 }]);
    bad([{ account: ACCOUNTS.nodal, debitPaise: 0 }, { account: ACCOUNTS.escrow(U), creditPaise: 0 }]);
    bad([{ account: ACCOUNTS.nodal, debitPaise: -5 }, { account: ACCOUNTS.escrow(U), creditPaise: 5 }]);
    bad([{ account: ACCOUNTS.nodal, debitPaise: 1.5 }, { account: ACCOUNTS.escrow(U), creditPaise: 1.5 }]);
    bad([{ account: "made_up", debitPaise: 5 }, { account: ACCOUNTS.escrow(U), creditPaise: 5 }]);
  });
  it("classifies accounts", () => {
    expect(accountSpec("partner_nodal")).toEqual({ kind: "asset", normal: "debit" });
    expect(accountSpec("platform_fee").kind).toBe("revenue");
    expect(accountSpec("gst_output").normal).toBe("credit");
    expect(accountSpec(ACCOUNTS.sellerPayable(U)).kind).toBe("liability");
    expect(accountSpec(ACCOUNTS.refundPayable(V)).kind).toBe("liability");
  });
  it("property: any balanced journal set keeps total debits = total credits and a zero-sum balance sheet", () => {
    const journal = fc.record({ amount: fc.integer({ min: 1, max: 1e9 }), split: fc.integer({ min: 0, max: 100 }) }).map(({ amount, split }) => {
      const fee = Math.floor((amount * split) / 1000);
      return [
        { account: ACCOUNTS.escrow(U), debitPaise: amount },
        { account: ACCOUNTS.sellerPayable(V), creditPaise: amount - fee },
        ...(fee > 0 ? [{ account: ACCOUNTS.fee, creditPaise: fee }] : []),
      ];
    });
    fc.assert(fc.property(fc.array(journal, { minLength: 1, maxLength: 20 }), (js) => {
      const all = js.flatMap((j) => validateLines(j));
      const d = all.reduce((a, l) => a + l.debit, 0n);
      const c = all.reduce((a, l) => a + l.credit, 0n);
      expect(d).toBe(c);
      // all accounts here are credit-normal: their balances (credit - debit) must sum to zero
      const total = [...balancesOf(all).values()].reduce((x, v) => x + v, 0n);
      expect(total).toBe(0n);
    }));
  });
  it("property: perturbing any balanced journal by one paisa is rejected", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 1e9 }), fc.integer({ min: 1, max: 1e6 }), (amount, delta) => {
      expect(() => validateLines([{ account: ACCOUNTS.nodal, debitPaise: amount }, { account: ACCOUNTS.escrow(U), creditPaise: amount + delta }])).toThrow(DomainError);
    }));
  });
});

describe("fee", () => {
  it("is bps of the amount, capped, rounded half-up", () => {
    expect(computeFee(1_000_000, 150, 500_000)).toBe(15_000);
    expect(computeFee(1_000_000_000, 150, 500_000)).toBe(500_000);
    expect(computeFee(333, 150, 500_000)).toBe(5);
    expect(computeFee(0)).toBe(0);
    expect(() => computeFee(-1)).toThrow(DomainError);
    expect(() => computeFee(1.5)).toThrow(DomainError);
  });
  it("breakdown: GST 18% on the fee, seller net = amount - fee - gst", () => {
    expect(feeBreakdown(1_000_000)).toEqual({ feePaise: 15_000, gstPaise: 2_700, netPaise: 982_300 });
    expect(() => feeBreakdown(100, { bps: 500, gstBps: 1_000_000 })).toThrow(DomainError);
  });
  it("property: fee <= cap, fee+gst+net = amount, never negative", () => {
    fc.assert(fc.property(fc.integer({ min: 10_000, max: 5e10 }), fc.integer({ min: 0, max: 500 }), (amount, bps) => {
      const b = feeBreakdown(amount, { bps, capPaise: 500_000, gstBps: 1800 });
      expect(b.feePaise).toBeLessThanOrEqual(500_000);
      expect(b.feePaise + b.gstPaise + b.netPaise).toBe(amount);
      expect(b.netPaise).toBeGreaterThanOrEqual(0);
    }));
  });
});

describe("state machine", () => {
  const all = Object.keys(TRANSITIONS) as EscrowStatus[];
  it("only allows declared transitions; released/refunded are final", () => {
    expect(canTransition("created", "awaiting_funding")).toBe(true);
    expect(canTransition("funded", "released")).toBe(true);
    expect(canTransition("released", "funded")).toBe(false);
    expect(canTransition("refunded", "released")).toBe(false);
    expect(canTransition("awaiting_funding", "released")).toBe(false);
    for (const s of ["released", "refunded"] as const) expect(TRANSITIONS[s]).toEqual([]);
    expect(all.filter(isTerminal).sort()).toEqual(["cancelled", "refunded", "released"]);
    expect(all.filter(isHolding)).toEqual(["funded", "accepted"]);
    expect(ESCROWABLE_ORDER_STATUSES).toEqual(["recorded", "confirmed"]);
  });
  it("maps order statuses to milestones", () => {
    expect(milestoneForOrderStatus("confirmed")).toBe("confirmed");
    expect(milestoneForOrderStatus("dispatched")).toBe("dispatched");
    expect(milestoneForOrderStatus("delivered")).toBe("delivered");
    expect(milestoneForOrderStatus("completed")).toBe("accepted");
    expect(milestoneForOrderStatus("cancelled")).toBeNull();
    expect(milestoneForOrderStatus("recorded")).toBeNull();
  });
});

describe("stats helpers + reconcile diff", () => {
  it("percentile / conversion", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(escrowConversionRate(2, 10)).toBe(0.2);
    expect(escrowConversionRate(2, 0)).toBe(0);
  });
  it("diffSums", () => {
    const p = new Map([["a|collect", 100], ["b|collect", 50], ["d|payout", 5]]);
    const l = new Map([["a|collect", 100], ["b|collect", 60], ["c|collect", 7]]);
    expect(diffSums(p, l, true).map((d) => `${d.kind}:${d.key}`).sort()).toEqual(["amount_mismatch:b|collect", "missing_at_partner:c|collect", "missing_in_ledger:d|payout"]);
    expect(diffSums(p, l, false).map((d) => d.kind).sort()).toEqual(["amount_mismatch", "missing_in_ledger"]);
  });
});
