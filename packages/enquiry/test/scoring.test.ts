import { describe, expect, it } from "vitest";
import { assignSlots, geoFactor, matchScore, rankCandidates, reliabilityFactor, type SellerSignals } from "../src/scoring";

const sig = (o: Partial<SellerSignals> = {}): SellerSignals => ({ trustScore: 50, verificationTier: 0, badgeActive: false, city: null, state: null, pincode: null, ...o });

describe("scoring", () => {
  it("reliability rises with trust, badge and tier", () => {
    expect(reliabilityFactor(sig({ trustScore: 0 }))).toBeCloseTo(0.5);
    expect(reliabilityFactor(sig({ trustScore: 100 }))).toBeCloseTo(1);
    expect(reliabilityFactor(sig({ trustScore: 100, badgeActive: true, verificationTier: 2 }))).toBeCloseTo(1.09);
  });

  it("geo boosts same pincode prefix > city > state, never penalises", () => {
    const buyer = { pincode: "560001", city: "Bengaluru", state: "KA" };
    expect(geoFactor(buyer, { pincode: "560099" })).toBe(1.15);
    expect(geoFactor(buyer, { pincode: "110001", city: "bengaluru" })).toBe(1.1);
    expect(geoFactor(buyer, { pincode: "570001", state: "KA" })).toBe(1.05);
    expect(geoFactor(buyer, { pincode: "110001", city: "Delhi", state: "DL" })).toBe(1);
  });

  it("match score = similarity × reliability × geo, negative similarity floors at 0", () => {
    expect(matchScore(0.8, sig({ trustScore: 100 }), {})).toBeCloseTo(0.8);
    expect(matchScore(-0.3, sig(), {})).toBe(0);
  });

  const cands = [
    { sellerBusinessId: "a", listingId: "la", similarity: 0.9 },
    { sellerBusinessId: "b", listingId: "lb", similarity: 0.8 },
    { sellerBusinessId: "c", listingId: "lc", similarity: 0.7 },
    { sellerBusinessId: "d", listingId: "ld", similarity: 0.95 },
  ];
  const profs = new Map<string, SellerSignals>([
    ["a", sig({ trustScore: 40 })],
    ["b", sig({ trustScore: 100, badgeActive: true, verificationTier: 2 })],
    ["c", sig({ trustScore: 90 })],
    // d has no profile → dropped
  ]);

  it("ranks by relevance × trust and drops unknown/excluded sellers", () => {
    const r = rankCandidates(cands, profs, {}, { exclude: ["c"] });
    expect(r.map((x) => x.sellerBusinessId)).toEqual(["b", "a"]);
  });

  it("puts the preferred seller first when eligible, ignores it otherwise", () => {
    expect(rankCandidates(cands, profs, {}, { preferredSellerId: "a" })[0]!.sellerBusinessId).toBe("a");
    expect(rankCandidates(cands, profs, {}, { preferredSellerId: "zzz" })[0]!.sellerBusinessId).toBe("b");
  });

  it("cascade fills vacated rank slots, never exceeding the cap", () => {
    const ranked = rankCandidates(cands, profs, {});
    expect(assignSlots(ranked, [1, 3], 3).map((s) => s.rank)).toEqual([2]);
    expect(assignSlots(ranked, [], 2).map((s) => s.rank)).toEqual([1, 2]);
    expect(assignSlots(ranked, [1, 2, 3], 3)).toEqual([]);
    expect(assignSlots([], [1], 3)).toEqual([]);
  });
});
