// Compliance policy constants, all overridable via env with safe defaults (ADR-010).
//
// Sources (checked Sept 2026, verify against the gazetted text before relying on them):
//  - DPDP Rules 2025 (notified 13 Nov 2025, G.S.R. 846(E)): grievance redressal within a period not exceeding 90 days;
//    breach: intimate the Data Protection Board without delay + detailed report within 72 hours, notify data principals.
//  - IT (Intermediary Guidelines) Rules 2021, r.3(2): grievance officer acknowledges within 24 hours, disposes within 15 days.
//  - IT Rules 2021, r.3(1)(d): on a takedown notice (abuse / IPR report, grievance category "report") the intermediary
//    acts within 36 hours; we acknowledge within 24 hours.
// We adopt the STRICTER of the two (24h acknowledgement, 15 days resolution) as the default SLA.

/** Takedown notices (category "report", IT Rules 2021 r.3(1)(d)): acknowledge within 24h, act within 36h. */
export const TAKEDOWN_ACK_HOURS = 24;
export const TAKEDOWN_ACT_HOURS = 36;

const num = (raw: string | undefined, fallback: number, min = 1): number => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export interface GrievancePolicy {
  /** hours until a ticket must have left "open" (be acknowledged by the Grievance Officer) */
  ackHours: number;
  /** days until a ticket must be resolved (dueAt = createdAt + resolveDays) */
  resolveDays: number;
  /** tickets per raiser per hour (abuse guard) */
  perHourLimit: number;
  /** days to answer a data-principal RIGHTS request (access, correction, erasure, nomination, withdraw consent) */
  rightsRequestDays: number;
  /** hours to acknowledge a takedown notice (category "report") */
  takedownAckHours: number;
  /** hours to ACT on a takedown notice: its dueAt = createdAt + takedownActHours */
  takedownActHours: number;
}

export function grievancePolicy(env: NodeJS.ProcessEnv = process.env): GrievancePolicy {
  return {
    ackHours: num(env.GRIEVANCE_ACK_HOURS, 24),
    resolveDays: num(env.GRIEVANCE_RESOLVE_DAYS, 15),
    perHourLimit: num(env.GRIEVANCE_RATE_LIMIT_PER_HOUR, 5),
    // DPDP Rules 2025: a request to exercise a right (ss.11-14) is answered within the grievance window, at most 90 days.
    rightsRequestDays: num(env.GRIEVANCE_RIGHTS_REQUEST_DAYS, 90),
    takedownAckHours: num(env.GRIEVANCE_TAKEDOWN_ACK_HOURS, TAKEDOWN_ACK_HOURS),
    takedownActHours: num(env.GRIEVANCE_TAKEDOWN_ACT_HOURS, TAKEDOWN_ACT_HOURS),
  };
}

export const numFromEnv = num;
