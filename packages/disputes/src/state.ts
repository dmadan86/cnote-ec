// Pure dispute rules: state machine, deadlines, auto-resolve routing, outcome arithmetic. No I/O (unit-tested directly).
import { DomainError } from "@cnote/core";
import { DAY_MS, SLA_DAYS, type DisputeConfig, type DisputeTypeName } from "./config";

export type DisputeStatus = "open" | "evidence" | "brief_ready" | "auto_resolved" | "awaiting_adjudication" | "resolved" | "withdrawn";
export type DisputeOutcome = "buyer_favour" | "seller_favour" | "split";

/** open -> evidence -> brief_ready -> (auto_resolved | awaiting_adjudication) -> resolved | withdrawn. */
export const TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ["evidence", "withdrawn", "resolved"],
  evidence: ["brief_ready", "awaiting_adjudication", "withdrawn", "resolved"],
  brief_ready: ["auto_resolved", "awaiting_adjudication", "withdrawn", "resolved"],
  auto_resolved: ["resolved", "awaiting_adjudication", "withdrawn"],
  awaiting_adjudication: ["resolved", "withdrawn"],
  resolved: [],
  withdrawn: [],
};
export const ACTIVE_STATUSES: DisputeStatus[] = ["open", "evidence", "brief_ready", "auto_resolved", "awaiting_adjudication"];
/** Statuses in which parties may still add evidence (before the AI brief is written). */
export const EVIDENCE_OPEN_STATUSES: DisputeStatus[] = ["open", "evidence"];

export const isActive = (s: DisputeStatus) => ACTIVE_STATUSES.includes(s);
export const canTransition = (from: DisputeStatus, to: DisputeStatus) => TRANSITIONS[from].includes(to);
export function assertTransition(from: DisputeStatus, to: DisputeStatus): void {
  if (!canTransition(from, to)) throw new DomainError("conflict", `A dispute that is ${from.replace("_", " ")} cannot become ${to.replace("_", " ")}.`);
}

export function deadlines(now: Date, cfg: Pick<DisputeConfig, "responseHours">): { dueAt: Date; responseDueAt: Date } {
  return { dueAt: new Date(now.getTime() + SLA_DAYS * DAY_MS), responseDueAt: new Date(now.getTime() + cfg.responseHours * 3_600_000) };
}

export interface RoutingInput {
  type: DisputeTypeName;
  /** claimed amount (paise) or null */
  claimedPaise: number | null;
  recommendation: { outcome: DisputeOutcome; refundPaise: number };
  confidence: number;
  needsReview: boolean;
}
/** ADR-013: auto-resolve only clear, low-value, high-confidence cases of an allow-listed type. Anything else goes to a human. */
export function routeBrief(i: RoutingInput, cfg: DisputeConfig): { autoResolvable: boolean; reason: string } {
  if (!cfg.autoTypes.includes(i.type)) return { autoResolvable: false, reason: `type ${i.type} is not on the auto-resolve allowlist` };
  if (i.needsReview) return { autoResolvable: false, reason: "AI flagged the brief for human review" };
  if (i.confidence < cfg.autoMinConfidence) return { autoResolvable: false, reason: `confidence ${i.confidence.toFixed(2)} below ${cfg.autoMinConfidence}` };
  if (i.recommendation.outcome === "split") return { autoResolvable: false, reason: "evidence does not clearly favour one side" };
  const amount = Math.max(i.claimedPaise ?? 0, i.recommendation.refundPaise);
  if (amount > cfg.autoMaxPaise) return { autoResolvable: false, reason: `amount ${amount} above the auto-resolve ceiling ${cfg.autoMaxPaise}` };
  return { autoResolvable: true, reason: "clear, low-value, high-confidence" };
}

/** Who is at fault: the losing side of a clear outcome; nobody for a split. */
export function faultFor(outcome: DisputeOutcome, buyerBusinessId: string, sellerBusinessId: string): string | null {
  return outcome === "buyer_favour" ? sellerBusinessId : outcome === "seller_favour" ? buyerBusinessId : null;
}

/** Refund + release must account for exactly the amount at stake, and agree with the named outcome. */
export function validateSplit(outcome: DisputeOutcome, refundPaise: number, releasePaise: number, atStakePaise: number): void {
  const bad = (m: string) => new DomainError("validation", m);
  if (![refundPaise, releasePaise].every((n) => Number.isInteger(n) && n >= 0)) throw bad("Refund and release must be whole paise, 0 or more.");
  if (refundPaise + releasePaise !== atStakePaise) throw bad("Refund plus release must equal the amount held for this dispute.");
  if (outcome === "buyer_favour" && releasePaise !== 0) throw bad("A buyer-favour outcome refunds the full amount.");
  if (outcome === "seller_favour" && refundPaise !== 0) throw bad("A seller-favour outcome releases the full amount.");
  if (outcome === "split" && atStakePaise > 0 && (refundPaise === 0 || releasePaise === 0)) throw bad("A split must both refund and release something.");
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
