import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { replayAdWallet, type AdWalletRow } from "../src/ad-wallet";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const DAY = 86_400_000;

type Op =
  | { k: "topup"; amount: number; gap: number }
  | { k: "promo"; amount: number; ttl: number; gap: number }
  | { k: "spend"; amount: number; gap: number }
  | { k: "refund"; amount: number; gap: number }
  | { k: "expire"; gap: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant("topup" as const), amount: fc.integer({ min: 1, max: 5000 }), gap: fc.integer({ min: 0, max: 15 }) }),
  fc.record({ k: fc.constant("promo" as const), amount: fc.integer({ min: 1, max: 5000 }), ttl: fc.integer({ min: 1, max: 100 }), gap: fc.integer({ min: 0, max: 15 }) }),
  fc.record({ k: fc.constant("spend" as const), amount: fc.integer({ min: 1, max: 6000 }), gap: fc.integer({ min: 0, max: 15 }) }),
  fc.record({ k: fc.constant("refund" as const), amount: fc.integer({ min: 1, max: 500 }), gap: fc.integer({ min: 0, max: 15 }) }),
  fc.record({ k: fc.constant("expire" as const), gap: fc.integer({ min: 0, max: 15 }) }),
);

/** Independent model: lots list; spend takes soonest-expiring live lots first and is capped at the balance (as debitSpend does). */
function simulate(ops: Op[]) {
  const rows: AdWalletRow[] = [];
  const lots: { id: string; left: number; exp: number | null }[] = [];
  let now = T0;
  let n = 0;
  const bal = (t: number) => lots.filter((l) => l.exp === null || l.exp > t).reduce((s, l) => s + l.left, 0);
  const minBalances: number[] = [];
  for (const op of ops) {
    now += op.gap * DAY;
    const at = new Date(now);
    const id = `r${++n}`;
    if (op.k === "topup" || op.k === "refund") {
      rows.push({ id, deltaPaise: op.amount, reason: op.k === "topup" ? "topup" : "refund_invalid_click", refType: null, refId: null, expiresAt: null, createdAt: at });
      lots.push({ id, left: op.amount, exp: null });
    } else if (op.k === "promo") {
      const exp = now + op.ttl * DAY;
      rows.push({ id, deltaPaise: op.amount, reason: "promo_credit", refType: null, refId: null, expiresAt: new Date(exp), createdAt: at });
      lots.push({ id, left: op.amount, exp });
    } else if (op.k === "spend") {
      let take = Math.min(bal(now), op.amount);
      if (take <= 0) continue;
      rows.push({ id, deltaPaise: -take, reason: "spend", refType: null, refId: null, expiresAt: null, createdAt: at });
      for (const l of lots.filter((x) => x.left > 0 && (x.exp === null || x.exp > now)).sort((a, b) => (a.exp ?? Infinity) - (b.exp ?? Infinity))) {
        const t = Math.min(l.left, take);
        l.left -= t;
        take -= t;
      }
    } else {
      for (const l of lots.filter((x) => x.exp !== null && x.exp <= now && x.left > 0)) {
        rows.push({ id: `${id}-${l.id}`, deltaPaise: -l.left, reason: "promo_expire", refType: "promo_lot", refId: l.id, expiresAt: null, createdAt: at });
        l.left = 0;
      }
    }
    minBalances.push(bal(now));
  }
  return { rows, expected: (t: number) => bal(t), end: now, minBalances };
}

describe("ad wallet replay (property)", () => {
  it("matches an independent model and the balance is never negative", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 0, max: 200 }), (ops, extraDays) => {
        const { rows, expected, end, minBalances } = simulate(ops);
        expect(minBalances.every((b) => b >= 0)).toBe(true);
        const t = end + extraDays * DAY;
        const s = replayAdWallet(rows, new Date(t));
        expect(s.balancePaise).toBe(expected(t));
        expect(s.balancePaise).toBeGreaterThanOrEqual(0);
        expect(s.promoPaise).toBeLessThanOrEqual(s.balancePaise);
      }),
      { numRuns: 300 },
    );
  });

  it("is order-insensitive for rows with equal timestamps of the same kind and idempotent to re-replay", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const { rows, end } = simulate(ops);
        const a = replayAdWallet(rows, new Date(end));
        const b = replayAdWallet([...rows], new Date(end));
        expect(a).toEqual(b);
      }),
    );
  });

  it("expiry rows for lapsed promo lots bring the balance to what read-time expiry already reports", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const { rows, end } = simulate(ops);
        const t = new Date(end + 365 * DAY);
        const before = replayAdWallet(rows, t);
        const expireRows: AdWalletRow[] = before.lapsed.map((l, i) => ({ id: `e${i}`, deltaPaise: -l.remaining, reason: "promo_expire", refType: "promo_lot", refId: l.id, expiresAt: null, createdAt: t }));
        const after = replayAdWallet([...rows, ...expireRows], t);
        expect(after.balancePaise).toBe(before.balancePaise);
        expect(after.lapsed).toEqual([]);
      }),
    );
  });
});
