// ADR-020 success metrics from the negotiation tables (the event log carries the same facts for the metrics package).
import { prisma } from "@cnote/db";

export interface Range { from?: Date; to?: Date }
export interface A2aMetrics {
  negotiations: number;
  /** closed as accepted through both principals' confirmation */
  agentClosedDeals: number;
  /** share of accepted deals where BOTH sides confirmed by auto-accept */
  autoAcceptShare: number | null;
  /** share of accepted deals where at least one side was auto-confirmed */
  anyAutoShare: number | null;
  medianRoundsToClose: number | null;
  meanRoundsToClose: number | null;
  /** agreed by the agents but a person declined, or the confirmation window lapsed: humans overriding the agents */
  humanOverrideRate: number | null;
  agreedByAgents: number;
  humanDeclined: number;
  externalShare: number | null;
  flagged: number;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/**
 * agent-closed deals, auto-accept share, rounds to close, human override rate. "Agreed by agents" counts negotiations where an accept
 * message was sent; the override rate is the share of those a principal then declined (or let lapse) instead of confirming.
 */
export async function a2aMetrics(range: Range = {}): Promise<A2aMetrics> {
  const created = { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lt: range.to } : {}) };
  const rows = await prisma.agentNegotiation.findMany({ where: Object.keys(created).length ? { createdAt: created } : {}, select: { status: true, round: true, buyerConfirmation: true, sellerConfirmation: true, agreedTerms: true, buyerDriver: true, sellerDriver: true, flagged: true } });
  const agreed = rows.filter((r) => r.agreedTerms !== null);
  const accepted = rows.filter((r) => r.status === "accepted");
  const bothAuto = accepted.filter((r) => r.buyerConfirmation === "auto" && r.sellerConfirmation === "auto").length;
  const anyAuto = accepted.filter((r) => r.buyerConfirmation === "auto" || r.sellerConfirmation === "auto").length;
  const rounds = accepted.map((r) => r.round);
  const declined = agreed.filter((r) => r.status === "rejected" || r.status === "expired" || r.status === "withdrawn").length;
  return {
    negotiations: rows.length, agentClosedDeals: accepted.length, autoAcceptShare: ratio(bothAuto, accepted.length), anyAutoShare: ratio(anyAuto, accepted.length),
    medianRoundsToClose: median(rounds), meanRoundsToClose: rounds.length ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null,
    humanOverrideRate: ratio(declined, agreed.length), agreedByAgents: agreed.length, humanDeclined: declined,
    externalShare: ratio(rows.filter((r) => r.buyerDriver === "external" || r.sellerDriver === "external").length, rows.length), flagged: rows.filter((r) => r.flagged).length,
  };
}
