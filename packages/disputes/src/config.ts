// ADR-013 configuration. Read per call so tests and ops can flip env without a restart.
import type { DisputeKind } from "@cnote/ai";

export const DISPUTE_TYPES = ["non_delivery", "quality_mismatch", "quantity_short", "damaged", "wrong_item", "payment_issue", "other"] as const satisfies readonly DisputeKind[];
export type DisputeTypeName = (typeof DISPUTE_TYPES)[number];

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** ADR-013: SLA is 7 days median; each case is due 7 days after it is opened. */
export const SLA_DAYS = 7;
/** Published policy: a party may appeal a decision within this many days. */
export const APPEAL_WINDOW_DAYS = 7;
/** DPDP: evidence is personal data. Legal to confirm (see docs/design/disputes.md). */
export const EVIDENCE_RETENTION_DAYS = 1095;

export function disputesEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.DISPUTES_ENABLED ?? "");
}

function num(name: string, fallback: number, min = 0): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && process.env[name] !== undefined && process.env[name] !== "" ? n : fallback;
}

export interface DisputeConfig {
  /** auto-resolve only at or below this amount, paise (default Rs 5,000) */
  autoMaxPaise: number;
  /** ... and at or above this brief confidence */
  autoMinConfidence: number;
  /** ... and only for these dispute types */
  autoTypes: DisputeTypeName[];
  /** counterparty response window */
  responseHours: number;
  /** window in which either party can escalate an auto-resolution */
  escalationHours: number;
}

export function disputeConfig(): DisputeConfig {
  const types = (process.env.DISPUTES_AUTO_TYPES ?? "quantity_short,damaged,wrong_item")
    .split(",").map((s) => s.trim()).filter((s): s is DisputeTypeName => (DISPUTE_TYPES as readonly string[]).includes(s));
  return {
    autoMaxPaise: Math.round(num("DISPUTES_AUTO_MAX_PAISE", 500_000)),
    autoMinConfidence: Math.min(1, num("DISPUTES_AUTO_MIN_CONFIDENCE", 0.85)),
    autoTypes: types,
    responseHours: num("DISPUTES_RESPONSE_HOURS", 72, 0),
    escalationHours: num("DISPUTES_ESCALATION_HOURS", 48, 0),
  };
}
