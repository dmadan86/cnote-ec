import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BAND_LIMITS, COMPONENT_MAX, CREDIT_MODEL_VERSION, EMPTY_FEATURES, SCORE_MAX, SCORE_MIN, bandFor, computeScore, featureKey, type CreditFeatures } from "../src/model";

const feat = fc.record({
  gstVerified: fc.boolean(), gstActive: fc.boolean(), gstVerifiedAgeDays: fc.option(fc.integer({ min: 0, max: 900 }), { nil: null }),
  gstFilingsTotal: fc.integer({ min: 0, max: 6 }), gstFilingsFiled: fc.integer({ min: 0, max: 6 }),
  escrowCompleted: fc.integer({ min: 0, max: 500 }), escrowVolumePaise: fc.integer({ min: 0, max: 2_000_000_000 }), escrowClean: fc.integer({ min: 0, max: 500 }), escrowRefunded: fc.integer({ min: 0, max: 100 }),
  disputesLost: fc.integer({ min: 0, max: 10 }), disputesOpen: fc.integer({ min: 0, max: 10 }), trustScore: fc.integer({ min: 0, max: 100 }), badgeActive: fc.boolean(),
}) as fc.Arbitrary<CreditFeatures>;

const best: CreditFeatures = {
  gstVerified: true, gstActive: true, gstVerifiedAgeDays: 0, gstFilingsTotal: 6, gstFilingsFiled: 6, escrowCompleted: 1000, escrowVolumePaise: 10_000_000_000, escrowClean: 1000,
  escrowRefunded: 0, disputesLost: 0, disputesOpen: 0, trustScore: 100, badgeActive: true,
};

describe("credit-v1", () => {
  it("component maxima sum to 600 and the extremes map to 300 and 900", () => {
    expect(Object.values(COMPONENT_MAX).reduce((a, b) => a + b, 0)).toBe(600);
    expect(computeScore(best).score).toBe(SCORE_MAX);
    expect(computeScore({ ...EMPTY_FEATURES, disputesLost: 10, disputesOpen: 10 }).score).toBe(SCORE_MIN);
    expect(computeScore(best).modelVersion).toBe(CREDIT_MODEL_VERSION);
  });

  it("is deterministic and always within 300..900 with a matching band", () => {
    fc.assert(fc.property(feat, (f) => {
      const a = computeScore(f), b = computeScore({ ...f });
      expect(a).toEqual(b);
      expect(a.score).toBeGreaterThanOrEqual(SCORE_MIN);
      expect(a.score).toBeLessThanOrEqual(SCORE_MAX);
      expect(a.band).toBe(bandFor(a.score));
      expect(a.reasons.length).toBeLessThanOrEqual(6);
    }), { numRuns: 300 });
  });

  it("is monotone: better signals never lower the score, worse ones never raise it", () => {
    fc.assert(fc.property(feat, fc.integer({ min: 1, max: 50 }), (f, d) => {
      const s = computeScore(f).score;
      expect(computeScore({ ...f, trustScore: Math.min(100, f.trustScore + d) }).score).toBeGreaterThanOrEqual(s);
      expect(computeScore({ ...f, escrowCompleted: f.escrowCompleted + d, escrowClean: f.escrowClean + d }).score).toBeGreaterThanOrEqual(s);
      expect(computeScore({ ...f, escrowVolumePaise: f.escrowVolumePaise + d * 100_000 }).score).toBeGreaterThanOrEqual(s);
      expect(computeScore({ ...f, disputesLost: f.disputesLost + d }).score).toBeLessThanOrEqual(s);
      expect(computeScore({ ...f, disputesOpen: f.disputesOpen + d }).score).toBeLessThanOrEqual(s);
      expect(computeScore({ ...f, escrowRefunded: f.escrowRefunded + d }).score).toBeLessThanOrEqual(s);
      if (f.gstVerifiedAgeDays !== null) expect(computeScore({ ...f, gstVerifiedAgeDays: f.gstVerifiedAgeDays + d }).score).toBeLessThanOrEqual(s);
      expect(computeScore({ ...f, gstVerified: true }).score).toBeGreaterThanOrEqual(computeScore({ ...f, gstVerified: false }).score);
    }), { numRuns: 300 });
  });

  it("filing ratio is monotone in filed count", () => {
    fc.assert(fc.property(feat, (f) => {
      const total = Math.max(1, f.gstFilingsTotal);
      const lo = computeScore({ ...f, gstFilingsTotal: total, gstFilingsFiled: 0 }).score;
      const hi = computeScore({ ...f, gstFilingsTotal: total, gstFilingsFiled: total }).score;
      expect(hi).toBeGreaterThanOrEqual(lo);
    }));
  });

  it("explains itself: negatives ranked by shortfall, positives only when strong, codes drawn from the model", () => {
    const r = computeScore({ ...best, gstVerified: false, gstActive: false, gstVerifiedAgeDays: null, disputesLost: 2, escrowRefunded: 5 });
    const neg = r.reasons.filter((x) => x.direction === "negative");
    const gaps = neg.map((x) => x.maxPoints - x.points);
    expect([...gaps].sort((a, b) => b - a)).toEqual(gaps);
    expect(neg.map((x) => x.code)).toContain("GST_NOT_VERIFIED");
    expect(r.reasons.filter((x) => x.direction === "positive").every((x) => x.points / x.maxPoints >= 0.8)).toBe(true);
    expect(computeScore(best).reasons.every((x) => x.direction === "positive")).toBe(true);
  });

  it("bands and limits", () => {
    expect([299, 499, 500, 599, 600, 699, 700, 799, 800, 900].map(bandFor)).toEqual(["poor", "poor", "fair", "fair", "good", "good", "very_good", "very_good", "excellent", "excellent"]);
    expect(BAND_LIMITS.poor.advanceBps).toBe(0);
    const order = ["poor", "fair", "good", "very_good", "excellent"] as const;
    for (let i = 1; i < order.length; i++) {
      expect(BAND_LIMITS[order[i]!].advanceBps).toBeGreaterThan(BAND_LIMITS[order[i - 1]!].advanceBps);
      expect(BAND_LIMITS[order[i]!].bnplCapPaise).toBeGreaterThan(BAND_LIMITS[order[i - 1]!].bnplCapPaise);
    }
  });

  it("featureKey is stable and sensitive", () => {
    expect(featureKey(best)).toBe(featureKey({ ...best }));
    expect(featureKey(best)).not.toBe(featureKey({ ...best, trustScore: 99 }));
  });
});
