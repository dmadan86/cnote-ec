// Escrow configuration (ADR-012). Everything is read lazily from env so tests and the worker can flip it at runtime.
import { DomainError } from "@cnote/core";
import { platformSupplier } from "@cnote/billing";

const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n : d;
};

/** Public entry points (create/fund/accept) refuse when the flag is off; worker money-side jobs keep running. */
export const escrowEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.ESCROW_ENABLED ?? "");

export function assertEscrowEnabled(): void {
  if (!escrowEnabled()) throw new DomainError("forbidden", "Escrow is not available yet.");
}

/** Fee target in basis points of the escrowed amount (ADR-012: 1-2%). Clamped to 0..500 to stay sane. */
export const feeBps = (env: NodeJS.ProcessEnv = process.env): number => Math.min(500, int(env.ESCROW_FEE_BPS, 150));
/** Cap on the per-order fee (paise). Default Rs 5,000. */
export const feeCapPaise = (env: NodeJS.ProcessEnv = process.env): number => int(env.ESCROW_FEE_CAP_PAISE, 500_000);
/** Days after delivery before funds auto-release when there is no dispute. */
export const autoReleaseDays = (env: NodeJS.ProcessEnv = process.env): number => Math.max(1, int(env.ESCROW_AUTO_RELEASE_DAYS, 7));
/** Hours a buyer has to fund an escrow before it lapses. */
export const fundingTtlHours = (env: NodeJS.ProcessEnv = process.env): number => Math.max(1, int(env.ESCROW_FUNDING_TTL_HOURS, 72));
/** Smallest order value that can be escrowed (paise). Default Rs 100. */
export const minAmountPaise = (env: NodeJS.ProcessEnv = process.env): number => Math.max(1, int(env.ESCROW_MIN_PAISE, 10_000));
/** Minutes a partner-side entry must age before reconciliation compares it (clock skew / settlement lag). */
export const reconGraceMinutes = (env: NodeJS.ProcessEnv = process.env): number => int(env.ESCROW_RECON_GRACE_MINUTES, 30);
export const gstRateBps = (): number => platformSupplier().gstRateBps;

export const DAY_MS = 86_400_000;
