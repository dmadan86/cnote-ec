// credit-v1: deterministic, explainable platform credit score (ADR-019). Score = 300 + component points (max 600) => 300..900.
// Every component is monotone in its inputs (more of a good signal never lowers the score, more of a bad one never raises it).
// The model sees FEATURES only (counts, ratios, flags): never raw GST returns.

export const CREDIT_MODEL_VERSION = "credit-v1";
export const SCORE_MIN = 300;
export const SCORE_MAX = 900;

export interface CreditFeatures {
  gstVerified: boolean;
  gstActive: boolean;
  /** days since the last successful GST verification / re-check; null when never verified */
  gstVerifiedAgeDays: number | null;
  /** last (up to 6) filing periods */
  gstFilingsTotal: number;
  gstFilingsFiled: number;
  escrowCompleted: number;
  escrowVolumePaise: number;
  /** completed escrows that never had a dispute freeze */
  escrowClean: number;
  escrowRefunded: number;
  disputesLost: number;
  disputesOpen: number;
  /** identity trust score 0..100 (tier, response behaviour, outcomes) */
  trustScore: number;
  badgeActive: boolean;
}

export const EMPTY_FEATURES: CreditFeatures = {
  gstVerified: false, gstActive: false, gstVerifiedAgeDays: null, gstFilingsTotal: 0, gstFilingsFiled: 0,
  escrowCompleted: 0, escrowVolumePaise: 0, escrowClean: 0, escrowRefunded: 0, disputesLost: 0, disputesOpen: 0, trustScore: 0, badgeActive: false,
};

export type ReasonCode =
  | "GST_NOT_VERIFIED" | "GST_STATUS_INACTIVE" | "GST_VERIFICATION_STALE" | "GST_FILINGS_MISSED"
  | "ESCROW_FEW_ORDERS" | "ESCROW_LOW_VOLUME" | "ESCROW_DISPUTED_ORDERS" | "ESCROW_REFUNDS"
  | "DISPUTES_LOST" | "DISPUTES_OPEN" | "TRUST_LOW";

export interface Reason { code: ReasonCode; direction: "positive" | "negative"; points: number; maxPoints: number }
export type Band = "poor" | "fair" | "good" | "very_good" | "excellent";

interface Component { code: ReasonCode; max: number; points: number }

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;

export const COMPONENT_MAX = {
  GST_NOT_VERIFIED: 60, GST_STATUS_INACTIVE: 40, GST_VERIFICATION_STALE: 30, GST_FILINGS_MISSED: 70,
  ESCROW_FEW_ORDERS: 80, ESCROW_LOW_VOLUME: 60, ESCROW_DISPUTED_ORDERS: 50, ESCROW_REFUNDS: 30,
  DISPUTES_LOST: 60, DISPUTES_OPEN: 40, TRUST_LOW: 80,
} as const satisfies Record<ReasonCode, number>;

const STALE_FULL_DAYS = 90;
const STALE_ZERO_DAYS = 365;
const ORDERS_FULL = 20;
const VOLUME_FULL_RUPEES = 5_000_000;

export function components(f: CreditFeatures): Component[] {
  const M = COMPONENT_MAX;
  const fresh = f.gstVerified && f.gstVerifiedAgeDays !== null
    ? clamp01((STALE_ZERO_DAYS - Math.max(0, f.gstVerifiedAgeDays)) / (STALE_ZERO_DAYS - STALE_FULL_DAYS)) : 0;
  const filings = f.gstFilingsTotal > 0 ? clamp01(f.gstFilingsFiled / f.gstFilingsTotal) : 0.5;
  const orders = Math.max(0, f.escrowCompleted);
  const vol = Math.max(0, f.escrowVolumePaise) / 100;
  const closed = f.escrowCompleted + f.escrowRefunded;
  const clean = f.escrowCompleted > 0 ? clamp01(f.escrowClean / f.escrowCompleted) : 0;
  const noRefund = closed > 0 ? clamp01(1 - f.escrowRefunded / closed) : 0;
  return [
    { code: "GST_NOT_VERIFIED", max: M.GST_NOT_VERIFIED, points: f.gstVerified ? M.GST_NOT_VERIFIED : 0 },
    { code: "GST_STATUS_INACTIVE", max: M.GST_STATUS_INACTIVE, points: f.gstVerified && f.gstActive ? M.GST_STATUS_INACTIVE : 0 },
    { code: "GST_VERIFICATION_STALE", max: M.GST_VERIFICATION_STALE, points: M.GST_VERIFICATION_STALE * fresh },
    { code: "GST_FILINGS_MISSED", max: M.GST_FILINGS_MISSED, points: f.gstVerified ? M.GST_FILINGS_MISSED * filings : 0 },
    { code: "ESCROW_FEW_ORDERS", max: M.ESCROW_FEW_ORDERS, points: M.ESCROW_FEW_ORDERS * clamp01(Math.log1p(orders) / Math.log1p(ORDERS_FULL)) },
    { code: "ESCROW_LOW_VOLUME", max: M.ESCROW_LOW_VOLUME, points: M.ESCROW_LOW_VOLUME * clamp01(Math.log1p(vol) / Math.log1p(VOLUME_FULL_RUPEES)) },
    { code: "ESCROW_DISPUTED_ORDERS", max: M.ESCROW_DISPUTED_ORDERS, points: M.ESCROW_DISPUTED_ORDERS * clean },
    { code: "ESCROW_REFUNDS", max: M.ESCROW_REFUNDS, points: M.ESCROW_REFUNDS * noRefund },
    { code: "DISPUTES_LOST", max: M.DISPUTES_LOST, points: Math.max(0, M.DISPUTES_LOST - 20 * Math.max(0, f.disputesLost)) },
    { code: "DISPUTES_OPEN", max: M.DISPUTES_OPEN, points: Math.max(0, M.DISPUTES_OPEN - 15 * Math.max(0, f.disputesOpen)) },
    { code: "TRUST_LOW", max: M.TRUST_LOW, points: 70 * clamp01(f.trustScore / 100) + (f.badgeActive ? 10 : 0) },
  ];
}

export function bandFor(score: number): Band {
  return score >= 800 ? "excellent" : score >= 700 ? "very_good" : score >= 600 ? "good" : score >= 500 ? "fair" : "poor";
}

/** Reasons: up to 4 negatives (largest shortfall first, adverse-action style) and up to 2 strong positives. Deterministic order. */
export function reasonsOf(cs: Component[]): Reason[] {
  const neg = cs.filter((c) => c.max - c.points >= 0.5)
    .sort((a, b) => (b.max - b.points) - (a.max - a.points) || a.code.localeCompare(b.code)).slice(0, 4)
    .map((c): Reason => ({ code: c.code, direction: "negative", points: round1(c.points), maxPoints: c.max }));
  const pos = cs.filter((c) => c.points / c.max >= 0.8)
    .sort((a, b) => b.points - a.points || a.code.localeCompare(b.code)).slice(0, 2)
    .map((c): Reason => ({ code: c.code, direction: "positive", points: round1(c.points), maxPoints: c.max }));
  return [...neg, ...pos];
}

export interface ScoreResult { score: number; band: Band; modelVersion: string; reasons: Reason[] }

export function computeScore(f: CreditFeatures): ScoreResult {
  const cs = components(f);
  const total = cs.reduce((a, c) => a + c.points, 0);
  const score = Math.min(SCORE_MAX, Math.max(SCORE_MIN, SCORE_MIN + Math.round(total)));
  return { score, band: bandFor(score), modelVersion: CREDIT_MODEL_VERSION, reasons: reasonsOf(cs) };
}

/** Per-band limits: share of the seller's net escrow proceeds that may be advanced and the BNPL ceiling (paise). */
export const BAND_LIMITS: Record<Band, { advanceBps: number; bnplCapPaise: number }> = {
  poor: { advanceBps: 0, bnplCapPaise: 0 },
  fair: { advanceBps: 6000, bnplCapPaise: 10_000_000 },
  good: { advanceBps: 7000, bnplCapPaise: 50_000_000 },
  very_good: { advanceBps: 8000, bnplCapPaise: 150_000_000 },
  excellent: { advanceBps: 8500, bnplCapPaise: 500_000_000 },
};

/** Stable hash input of a feature vector (dedupes identical recomputes). */
export const featureKey = (f: CreditFeatures): string => JSON.stringify(Object.keys(EMPTY_FEATURES).sort().map((k) => [k, (f as unknown as Record<string, unknown>)[k]]));
