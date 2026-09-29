import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, balanceAt, CREDIT_TTL_DAYS, lapsedRemainders, replayLots, spendableLots, type LedgerRow } from "../src/credits";
import { proRataRefundPaise } from "../src/subscriptions";

const T0 = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;

type Op =
  | { k: "grant"; amount: number; ttl: number; gap: number }
  | { k: "consume"; gap: number }
  | { k: "refund"; gap: number; pick: number }
  | { k: "expire"; gap: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant("grant" as const), amount: fc.integer({ min: 1, max: 6 }), ttl: fc.integer({ min: 1, max: 120 }), gap: fc.integer({ min: 1, max: 20 }) }),
  fc.record({ k: fc.constant("consume" as const), gap: fc.integer({ min: 1, max: 20 }) }),
  fc.record({ k: fc.constant("refund" as const), gap: fc.integer({ min: 1, max: 20 }), pick: fc.nat(50) }),
  fc.record({ k: fc.constant("expire" as const), gap: fc.integer({ min: 1, max: 20 }) }),
);

/** Independent reference model: a plain list of lots, simulated op by op. */
interface ModelLot { id: string; expires: number; left: number }
function simulate(ops: Op[]) {
  const rows: LedgerRow[] = [];
  const lots: ModelLot[] = [];
  const consumes: LedgerRow[] = [];
  const refunded = new Set<string>();
  let now = T0.getTime();
  let seq = 0;
  const balance = (t: number) => lots.filter((l) => l.expires > t).reduce((s, l) => s + l.left, 0);
  for (const op of ops) {
    now += op.gap * DAY;
    const at = new Date(now);
    const id = `row${++seq}`;
    if (op.k === "grant") {
      const expires = now + op.ttl * DAY;
      rows.push({ id, delta: op.amount, reason: "grant", refType: "t", refId: id, expiresAt: new Date(expires), createdAt: at });
      lots.push({ id, expires, left: op.amount });
    } else if (op.k === "consume") {
      if (balance(now) < 1) continue; // domain rule: consume only with spendable balance
      const lot = lots.filter((l) => l.expires > now && l.left > 0).sort((a, b) => a.expires - b.expires)[0]!;
      lot.left -= 1;
      const r: LedgerRow = { id, delta: -1, reason: "consume", refType: "m", refId: id, expiresAt: null, createdAt: at };
      rows.push(r);
      consumes.push(r);
    } else if (op.k === "refund") {
      const c = consumes.filter((x) => !refunded.has(x.id))[op.pick % Math.max(1, consumes.filter((x) => !refunded.has(x.id)).length)];
      if (!c) continue;
      refunded.add(c.id);
      const expires = now + CREDIT_TTL_DAYS * DAY;
      rows.push({ id, delta: 1, reason: "refund", refType: "consume", refId: c.id, expiresAt: new Date(expires), createdAt: at });
      lots.push({ id, expires, left: 1 });
    } else {
      for (const l of lots.filter((x) => x.expires <= now && x.left > 0)) {
        rows.push({ id: `${id}-${l.id}`, delta: -l.left, reason: "expire", refType: "grant", refId: l.id, expiresAt: null, createdAt: at });
        l.left = 0;
      }
    }
  }
  return { rows, lots, now, balance };
}

describe("ledger replay properties", () => {
  it("balance equals the reference model, is never negative and never counts expired credit", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 0, max: 60 }), (ops, extra) => {
        const { rows, lots, now, balance } = simulate(ops);
        const at = new Date(now + extra * DAY);
        const b = balanceAt(rows, at);
        expect(b).toBe(balance(at.getTime()));
        expect(b).toBeGreaterThanOrEqual(0);
        for (const l of replayLots(rows)) expect(l.remaining).toBeGreaterThanOrEqual(0);
        for (const l of spendableLots(rows, at)) expect(l.expiresAt.getTime()).toBeGreaterThan(at.getTime());
        // lots agree with model lot-by-lot
        const byId = new Map(replayLots(rows).map((l) => [l.id, l.remaining]));
        for (const l of lots) expect(byId.get(l.id)).toBe(l.left);
      }),
      { numRuns: 300 },
    );
  });

  it("is order-independent on input (replay sorts chronologically)", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), fc.integer(), (ops, seed) => {
        const { rows, now } = simulate(ops);
        const shuffled = [...rows].sort((a, b) => ((a.id.length * 31 + seed) % 7) - ((b.id.length * 31 + seed) % 5));
        expect(balanceAt(shuffled, new Date(now))).toBe(balanceAt(rows, new Date(now)));
      }),
    );
  });

  it("writing off lapsed remainders is idempotent and leaves balance unchanged", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 0, max: 200 }), (ops, extra) => {
        const { rows, now } = simulate(ops);
        const at = new Date(now + extra * DAY);
        const before = balanceAt(rows, at);
        const writeOffs: LedgerRow[] = lapsedRemainders(rows, at).map((l, i) => ({
          id: `wo${i}`, delta: -l.amount, reason: "expire", refType: "grant", refId: l.lotId, expiresAt: null, createdAt: at,
        }));
        const after = [...rows, ...writeOffs];
        expect(lapsedRemainders(after, at)).toEqual([]);
        expect(balanceAt(after, at)).toBe(before);
      }),
    );
  });
});

describe("credit expiry boundaries (ADR-005 90-day rollover)", () => {
  const g: LedgerRow = { id: "g", delta: 5, reason: "grant", refType: null, refId: null, expiresAt: addDays(T0, CREDIT_TTL_DAYS), createdAt: T0 };
  it("spendable strictly before the 90th day, gone exactly at expiry", () => {
    expect(balanceAt([g], new Date(g.expiresAt!.getTime() - 1))).toBe(5);
    expect(balanceAt([g], g.expiresAt!)).toBe(0);
    expect(lapsedRemainders([g], g.expiresAt!)).toEqual([{ lotId: "g", amount: 5 }]);
    expect(lapsedRemainders([g], new Date(g.expiresAt!.getTime() - 1))).toEqual([]);
  });
  it("consume exactly at expiry cannot draw from the lapsed lot", () => {
    const c: LedgerRow = { id: "c", delta: -1, reason: "consume", refType: null, refId: null, expiresAt: null, createdAt: g.expiresAt! };
    expect(replayLots([g, c])[0]!.remaining).toBe(5);
  });
  it("multi-unit consume spans lots in expiry order", () => {
    const a: LedgerRow = { ...g, id: "a", delta: 1, expiresAt: addDays(T0, 10) };
    const b: LedgerRow = { ...g, id: "b", delta: 3, expiresAt: addDays(T0, 50) };
    const c: LedgerRow = { id: "c", delta: -3, reason: "consume", refType: null, refId: null, expiresAt: null, createdAt: addDays(T0, 1) };
    const lots = replayLots([b, a, c]);
    expect(lots.find((l) => l.id === "a")!.remaining).toBe(0);
    expect(lots.find((l) => l.id === "b")!.remaining).toBe(1);
  });
  it("expire row for an unknown lot is ignored; over-large expire clamps to zero", () => {
    const e1: LedgerRow = { id: "e1", delta: -9, reason: "expire", refType: "grant", refId: "nope", expiresAt: null, createdAt: addDays(T0, 1) };
    const e2: LedgerRow = { ...e1, id: "e2", refId: "g" };
    expect(replayLots([g, e1])[0]!.remaining).toBe(5);
    expect(replayLots([g, e2])[0]!.remaining).toBe(0);
  });
});

describe("proRataRefundPaise properties", () => {
  it("is 0 for <=35-day periods; otherwise within [0, price], monotonic non-increasing in elapsed time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 1, max: 800 }), fc.integer({ min: -50, max: 900 }), fc.integer({ min: 0, max: 50 }), (price, days, elapsed, more) => {
        const end = addDays(T0, days);
        const r1 = proRataRefundPaise(price, T0, end, addDays(T0, elapsed));
        const r2 = proRataRefundPaise(price, T0, end, addDays(T0, elapsed + more));
        expect(Number.isInteger(r1)).toBe(true);
        expect(r1).toBeGreaterThanOrEqual(0);
        expect(r1).toBeLessThanOrEqual(price);
        expect(r2).toBeLessThanOrEqual(r1);
        if (days <= 35) expect(r1).toBe(0);
      }),
    );
  });
  it("edges: before start refunds everything, after end refunds nothing", () => {
    expect(proRataRefundPaise(1200, T0, addDays(T0, 365), addDays(T0, -5))).toBe(1200);
    expect(proRataRefundPaise(1200, T0, addDays(T0, 365), addDays(T0, 400))).toBe(0);
    expect(proRataRefundPaise(1200, T0, addDays(T0, 35), addDays(T0, 1))).toBe(0);
    expect(proRataRefundPaise(1200, T0, addDays(T0, 36), addDays(T0, 1))).toBeGreaterThan(0);
  });
});
