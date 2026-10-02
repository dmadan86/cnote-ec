import type { VerificationCheck, VerificationEvidence } from "@cnote/identity";

/** Structural copies of the module read models (kept local so this file stays free of server-only imports and is unit-testable). */
export interface ResponseLite {
  sufficient: boolean;
  sample: number;
  medianFirstResponseMinutes: number | null;
  acceptRate: number | null;
}
export interface SellerRatingLite {
  count: number;
  average: number;
  histogram: [number, number, number, number, number];
}

/**
 * Everything the supplier card, profile and compare table show about trust. Public, per-seller, plain JSON.
 * Built only from verification evidence, lead behaviour and reviews, so it can never reflect plan or payment (ADR-003).
 */
export interface SupplierTrust {
  businessId: string;
  tier: number;
  badgeActive: boolean;
  memberSince: string;
  memberSinceYear: number;
  /** whole years on the platform (0 when joined less than a year ago) */
  yearsOnPlatform: number;
  gstinMasked: string | null;
  checks: VerificationCheck[];
  passedChecks: VerificationCheck[];
  /** null response numbers + `isNew` when the 90-day sample is below the threshold */
  response: ResponseLite & { isNew: boolean };
  /** null when the supplier has no approved reviews: UIs must not show stars or JSON-LD aggregateRating then */
  rating: SellerRatingLite | null;
  liveListings: number;
  storefrontSlug: string | null;
}

export function buildSupplierTrust(i: {
  evidence: VerificationEvidence;
  response: ResponseLite | undefined;
  rating: SellerRatingLite | undefined;
  liveListings: number;
  storefrontSlug: string | null;
  now?: Date;
}): SupplierTrust {
  const joined = new Date(i.evidence.memberSince);
  const now = i.now ?? new Date();
  const years = Math.max(0, Math.floor((now.getTime() - joined.getTime()) / (365.25 * 24 * 3600 * 1000)));
  const r = i.response;
  const sufficient = !!r?.sufficient;
  return {
    businessId: i.evidence.businessId,
    tier: i.evidence.tier,
    badgeActive: i.evidence.badgeActive,
    memberSince: i.evidence.memberSince,
    memberSinceYear: joined.getUTCFullYear(),
    yearsOnPlatform: years,
    gstinMasked: i.evidence.gstinMasked,
    checks: i.evidence.checks,
    passedChecks: i.evidence.checks.filter((c) => c.passed),
    response: {
      sufficient,
      sample: r?.sample ?? 0,
      // Defence in depth: a below-threshold sample never carries numbers, even if a caller forgot to null them.
      medianFirstResponseMinutes: sufficient ? (r?.medianFirstResponseMinutes ?? null) : null,
      acceptRate: sufficient ? (r?.acceptRate ?? null) : null,
      isNew: !sufficient,
    },
    rating: i.rating && i.rating.count > 0 ? { count: i.rating.count, average: i.rating.average, histogram: i.rating.histogram } : null,
    liveListings: i.liveListings,
    storefrontSlug: i.storefrontSlug,
  };
}

/** Splits a duration for ICU plural messages: under 60 min -> minutes, under 48 h -> hours, else days. */
export function splitDuration(minutes: number): { unit: "minutes" | "hours" | "days"; value: number } {
  if (minutes < 60) return { unit: "minutes", value: Math.max(1, Math.round(minutes)) };
  if (minutes < 48 * 60) return { unit: "hours", value: Math.max(1, Math.round(minutes / 60)) };
  return { unit: "days", value: Math.max(2, Math.round(minutes / 1440)) };
}

export const acceptPercent = (rate: number | null): number | null => (rate == null ? null : Math.round(rate * 100));

/** Stable date format for evidence lists: the viewer's locale, UTC so server and client agree. */
export function formatEvidenceDate(iso: string, bcp47: string): string {
  return new Date(iso).toLocaleDateString(bcp47, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
