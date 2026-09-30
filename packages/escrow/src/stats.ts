// Metric inputs for @cnote/metrics (ADR-012 targets): >= 20% of matched leads convert to escrowed orders,
// escrow-order fraud rate < 0.5%, payout latency < 1 business day post-release.
import { prisma } from "@cnote/db";

export const ONE_DAY_MS = 86_400_000;

/** Nearest-rank percentile of a numeric sample (0 for an empty one). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** Escrowed orders / matched leads (matched leads come from the event log: LeadAccepted count, supplied by the caller). */
export function escrowConversionRate(escrowedOrders: number, matchedLeads: number): number {
  return matchedLeads > 0 ? escrowedOrders / matchedLeads : 0;
}

export interface EscrowStats {
  created: number;
  funded: number;
  fundedPaise: number;
  released: number;
  refunded: number;
  disputed: number;
  /** Placeholder proxy until ADR-013 fault data lands: funded escrows that were disputed AND refunded (fully or partly) / funded. */
  fraudRate: number;
  payoutLatency: { count: number; p50Ms: number; p95Ms: number; withinOneDayShare: number };
}

export async function escrowStats(range: { from: Date; to: Date }): Promise<EscrowStats> {
  const inRange = { gte: range.from, lt: range.to };
  const [created, funded, released, refunded, disputed, fraud, payouts] = await Promise.all([
    prisma.escrowAgreement.count({ where: { createdAt: inRange } }),
    prisma.escrowAgreement.findMany({ where: { fundedAt: inRange }, select: { amountPaise: true } }),
    prisma.escrowAgreement.count({ where: { status: "released", closedAt: inRange } }),
    prisma.escrowAgreement.count({ where: { status: "refunded", closedAt: inRange } }),
    prisma.escrowFreeze.count({ where: { openedAt: inRange } }),
    prisma.escrowAgreement.count({ where: { fundedAt: inRange, refundedPaise: { gt: 0 }, freezes: { some: {} } } }),
    prisma.escrowPayout.findMany({ where: { kind: "seller_payout", status: "settled", settledAt: inRange, latencyMs: { not: null } }, select: { latencyMs: true } }),
  ]);
  const lat = payouts.map((p) => p.latencyMs!);
  return {
    created, funded: funded.length, fundedPaise: funded.reduce((a, e) => a + Number(e.amountPaise), 0), released, refunded, disputed,
    fraudRate: funded.length > 0 ? fraud / funded.length : 0,
    payoutLatency: { count: lat.length, p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95), withinOneDayShare: lat.length ? lat.filter((l) => l < ONE_DAY_MS).length / lat.length : 1 },
  };
}
