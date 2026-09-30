// Credit configuration (ADR-019). Lazily read from env so tests and the worker can flip values at runtime.
import { DomainError } from "@cnote/core";

const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n : d;
};

export const DAY_MS = 86_400_000;

/** Public entry points (consent-driven scoring, apply, accept) refuse when off; webhooks and loan-book jobs keep running. */
export const creditEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.CREDIT_ENABLED ?? "");

export function assertCreditEnabled(): void {
  if (!creditEnabled()) throw new DomainError("forbidden", "Credit is not available yet.");
}

export interface CreditConfig {
  /** minimum score for invoice financing / BNPL */
  minScore: number;
  bnplMinScore: number;
  /** smallest financeable amount (paise) */
  minAmountPaise: number;
  offerTtlHours: number;
  /** RBI digital lending guidelines: borrower may exit without penalty in this window (days) */
  coolingOffDays: number;
  /** late payment charge disclosed in the KFS (bps per month on overdue amount) */
  lateFeeBpsPerMonth: number;
  /** first-loss default guarantee cap, bps of the originated book (partner negotiated) */
  fldgCapBps: number;
  /** ADR-019 targets */
  gnpaTargetBps: number;
  attachedGmvTargetBps: number;
}

export const creditConfig = (env: NodeJS.ProcessEnv = process.env): CreditConfig => ({
  minScore: int(env.CREDIT_MIN_SCORE, 500),
  bnplMinScore: int(env.CREDIT_BNPL_MIN_SCORE, 550),
  minAmountPaise: int(env.CREDIT_MIN_AMOUNT_PAISE, 500_000),
  offerTtlHours: Math.max(1, int(env.CREDIT_OFFER_TTL_HOURS, 48)),
  coolingOffDays: int(env.CREDIT_COOLING_OFF_DAYS, 3),
  lateFeeBpsPerMonth: int(env.CREDIT_LATE_FEE_BPS_PER_MONTH, 200),
  fldgCapBps: Math.min(10_000, int(env.CREDIT_FLDG_CAP_BPS, 500)),
  gnpaTargetBps: int(env.CREDIT_GNPA_TARGET_BPS, 200),
  attachedGmvTargetBps: int(env.CREDIT_ATTACHED_GMV_TARGET_BPS, 1500),
});
