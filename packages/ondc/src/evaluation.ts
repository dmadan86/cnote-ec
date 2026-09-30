// ADR-021 evaluation: incremental GMV and dispute load from the ONDC channel over a window (the plan measures two quarters
// before deciding on buyer-side participation). Read-only. `network buyers have no platform business`, so every non-cancelled
// ONDC order is GMV the platform did not have from its own buyers: that is the incremental figure (an upper bound on
// cannibalisation-free GMV; overlap with existing buyers cannot be observed because network buyers are anonymous to us).
import { prisma } from "@cnote/db";

export interface OndcEvaluation {
  from: string;
  to: string;
  orders: { total: number; cancelled: number; completed: number };
  /** GMV of non-cancelled ONDC orders, paise */
  incrementalGmvPaise: number;
  gmvByMonth: { month: string; gmvPaise: number; orders: number }[];
  issues: { total: number; open: number; resolved: number; closed: number; overdue: number; needsManual: number; withDispute: number; byCategory: Record<string, number> };
  /** IGM issues and disputes per 100 orders in the window */
  issuesPer100Orders: number;
  disputesPer100Orders: number;
  /** share of resolved issues resolved before their expected resolution time, 0..1 (null when none resolved) */
  resolvedWithinTtl: number | null;
  medianResolutionHours: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export async function ondcEvaluation(from: Date, to: Date, now: Date = new Date()): Promise<OndcEvaluation> {
  const orders = await prisma.ondcOrder.findMany({ where: { createdAt: { gte: from, lt: to } }, select: { createdAt: true, totalPaise: true, status: true }, take: 100_000 });
  const issues = await prisma.ondcIssue.findMany({
    where: { createdAt: { gte: from, lt: to } },
    select: { status: true, category: true, needsManual: true, disputeId: true, createdAt: true, resolvedAt: true, expectedResolutionAt: true },
    take: 100_000,
  });
  const live = orders.filter((o) => o.status !== "cancelled");
  const byMonth = new Map<string, { gmvPaise: number; orders: number }>();
  for (const o of live) {
    const k = o.createdAt.toISOString().slice(0, 7);
    const v = byMonth.get(k) ?? { gmvPaise: 0, orders: 0 };
    v.gmvPaise += Number(o.totalPaise);
    v.orders++;
    byMonth.set(k, v);
  }
  const done = issues.filter((i) => i.status === "resolved" && i.resolvedAt);
  const byCategory: Record<string, number> = {};
  for (const i of issues) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  const per100 = (n: number) => (orders.length ? Math.round((n / orders.length) * 1000) / 10 : 0);
  return {
    from: from.toISOString(), to: to.toISOString(),
    orders: { total: orders.length, cancelled: orders.length - live.length, completed: orders.filter((o) => o.status === "completed").length },
    incrementalGmvPaise: live.reduce((a, o) => a + Number(o.totalPaise), 0),
    gmvByMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    issues: {
      total: issues.length, open: issues.filter((i) => i.status === "open" || i.status === "processing").length, resolved: done.length,
      closed: issues.filter((i) => i.status === "closed").length,
      overdue: issues.filter((i) => (i.status === "open" || i.status === "processing") && i.expectedResolutionAt < now).length,
      needsManual: issues.filter((i) => i.needsManual).length, withDispute: issues.filter((i) => i.disputeId).length, byCategory,
    },
    issuesPer100Orders: per100(issues.length),
    disputesPer100Orders: per100(issues.filter((i) => i.disputeId).length),
    resolvedWithinTtl: done.length ? done.filter((i) => i.resolvedAt! <= i.expectedResolutionAt).length / done.length : null,
    medianResolutionHours: (() => { const m = median(done.map((i) => (i.resolvedAt!.getTime() - i.createdAt.getTime()) / 3_600_000)); return m === null ? null : Math.round(m * 10) / 10; })(),
  };
}
