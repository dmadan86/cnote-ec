// Pure credit-ledger math (ADR-005). No I/O so it is trivially testable.
//
// Approach: the ledger is append-only and `consume` rows do NOT name the grant they draw from.
// Instead FIFO is derived on read by replaying the ledger chronologically:
//   - every positive entry (grant / refund) is a "lot" with an expiry;
//   - each consume takes 1 credit from the earliest-expiring lot that exists and is unexpired at
//     the time of the consume;
//   - an "expire" row (refType "grant", refId = lot id) zeroes the lapsed remainder of that lot.
// Refunds re-enter as a fresh lot (expiry = refund time + 90d) rather than un-consuming the old
// lot, so a refund can never resurrect already-lapsed credit and stays a simple append.

export const CREDIT_TTL_DAYS = 90;

export interface LedgerRow {
  id: string;
  delta: number;
  reason: "grant" | "consume" | "refund" | "expire";
  refType: string | null;
  refId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface Lot {
  id: string;
  expiresAt: Date;
  createdAt: Date;
  granted: number;
  remaining: number;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Replays the ledger; returns every lot with its remaining (un-consumed, un-expired-row) amount. */
export function replayLots(rows: LedgerRow[]): Lot[] {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.reason.localeCompare(b.reason));
  const lots: Lot[] = [];
  for (const r of sorted) {
    if (r.delta > 0 && r.expiresAt) {
      lots.push({ id: r.id, expiresAt: r.expiresAt, createdAt: r.createdAt, granted: r.delta, remaining: r.delta });
    } else if (r.reason === "consume") {
      let need = -r.delta;
      const usable = lots
        .filter((l) => l.remaining > 0 && l.expiresAt > r.createdAt)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
      for (const l of usable) {
        const take = Math.min(l.remaining, need);
        l.remaining -= take;
        need -= take;
        if (need === 0) break;
      }
    } else if (r.reason === "expire" && r.refId) {
      const lot = lots.find((l) => l.id === r.refId);
      if (lot) lot.remaining = Math.max(0, lot.remaining + r.delta);
    }
  }
  return lots;
}

/** Lots that can still be spent at `now`. */
export function spendableLots(rows: LedgerRow[], now: Date): Lot[] {
  return replayLots(rows).filter((l) => l.remaining > 0 && l.expiresAt > now);
}

export function balanceAt(rows: LedgerRow[], now: Date): number {
  return spendableLots(rows, now).reduce((s, l) => s + l.remaining, 0);
}

/** Lapsed lots that still hold credit and have no "expire" row yet → amounts to write off. */
export function lapsedRemainders(rows: LedgerRow[], now: Date): { lotId: string; amount: number }[] {
  return replayLots(rows)
    .filter((l) => l.remaining > 0 && l.expiresAt <= now)
    .map((l) => ({ lotId: l.id, amount: l.remaining }));
}
