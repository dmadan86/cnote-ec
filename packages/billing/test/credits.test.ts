import { describe, expect, it } from "vitest";
import { addDays, balanceAt, lapsedRemainders, replayLots, type LedgerRow } from "../src/credits";
import { proRataRefundPaise } from "../src/subscriptions";

const t0 = new Date("2026-01-01T00:00:00Z");
let n = 0;
const row = (p: Partial<LedgerRow> & Pick<LedgerRow, "delta" | "reason">, at: Date): LedgerRow => ({
  id: `r${++n}`, refType: null, refId: null, expiresAt: null, createdAt: at, ...p,
});
const grant = (amount: number, at: Date, days = 90) => row({ delta: amount, reason: "grant", expiresAt: addDays(at, days) }, at);
const consume = (at: Date) => row({ delta: -1, reason: "consume" }, at);

describe("credit ledger math", () => {
  it("balance = grants minus consumption", () => {
    const rows = [grant(10, t0), consume(addDays(t0, 1)), consume(addDays(t0, 2))];
    expect(balanceAt(rows, addDays(t0, 3))).toBe(8);
  });

  it("consumes FIFO from the earliest-expiring lot", () => {
    const a = grant(2, t0, 30);
    const b = grant(5, addDays(t0, 1), 90);
    const lots = replayLots([a, b, consume(addDays(t0, 2)), consume(addDays(t0, 3)), consume(addDays(t0, 4))]);
    expect(lots.find((l) => l.id === a.id)!.remaining).toBe(0);
    expect(lots.find((l) => l.id === b.id)!.remaining).toBe(4);
  });

  it("lapsed credits stop counting and are reported for write-off", () => {
    const a = grant(10, t0, 30);
    const rows = [a, consume(addDays(t0, 1))];
    const later = addDays(t0, 31);
    expect(balanceAt(rows, later)).toBe(0);
    expect(lapsedRemainders(rows, later)).toEqual([{ lotId: a.id, amount: 9 }]);
    const withExpire = [...rows, row({ delta: -9, reason: "expire", refType: "grant", refId: a.id }, later)];
    expect(lapsedRemainders(withExpire, later)).toEqual([]);
  });

  it("does not spend a lot that had already lapsed at consume time", () => {
    const rows = [grant(1, t0, 10), grant(1, addDays(t0, 5), 90), consume(addDays(t0, 11))];
    const lots = replayLots(rows);
    expect(lots[0]!.remaining).toBe(1); // lapsed, untouched
    expect(lots[1]!.remaining).toBe(0);
  });

  it("refund re-enters as a fresh lot", () => {
    const c = consume(addDays(t0, 1));
    const rows = [grant(1, t0), c, row({ delta: 1, reason: "refund", refType: "consume", refId: c.id, expiresAt: addDays(t0, 91) }, addDays(t0, 2))];
    expect(balanceAt(rows, addDays(t0, 3))).toBe(1);
  });
});

describe("pro-rata refund", () => {
  it("is zero for monthly periods and proportional for annual", () => {
    expect(proRataRefundPaise(99_900, t0, addDays(t0, 30), addDays(t0, 10))).toBe(0);
    expect(proRataRefundPaise(1_000_000, t0, addDays(t0, 360), addDays(t0, 90))).toBe(750_000);
  });
});
