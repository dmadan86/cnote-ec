import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { enquiryInputSchema, messageSchema, quoteSchema } from "../src/schemas";
import { assignSlots, geoFactor, matchScore, rankCandidates, reliabilityFactor, type Candidate, type SellerSignals } from "../src/scoring";

const sigArb: fc.Arbitrary<SellerSignals> = fc.record({
  trustScore: fc.integer({ min: -20, max: 130 }),
  verificationTier: fc.integer({ min: -1, max: 5 }),
  badgeActive: fc.boolean(),
  city: fc.option(fc.constantFrom("Pune", "pune ", "Delhi", ""), { nil: null }),
  state: fc.option(fc.constantFrom("MH", "DL", ""), { nil: null }),
  pincode: fc.option(fc.constantFrom("411001", "411045", "110001", "12"), { nil: null }),
});
const geoArb = fc.record({
  city: fc.option(fc.constantFrom("Pune", "PUNE", "Delhi"), { nil: null }),
  state: fc.option(fc.constantFrom("MH", "DL"), { nil: null }),
  pincode: fc.option(fc.constantFrom("411001", "411999", "110001", "1"), { nil: null }),
});

describe("match score properties", () => {
  it("reliability is bounded [0.5, 1.11] and monotone in trust, tier and badge", () => {
    fc.assert(
      fc.property(sigArb, fc.integer({ min: 0, max: 50 }), (s, more) => {
        const r = reliabilityFactor(s);
        expect(r).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect(r).toBeLessThanOrEqual(1.11 + 1e-9);
        expect(reliabilityFactor({ ...s, trustScore: s.trustScore + more })).toBeGreaterThanOrEqual(r - 1e-9);
        expect(reliabilityFactor({ ...s, verificationTier: s.verificationTier + more })).toBeGreaterThanOrEqual(r - 1e-9);
        expect(reliabilityFactor({ ...s, badgeActive: true })).toBeGreaterThanOrEqual(r - 1e-9);
      }),
    );
  });

  it("geo factor is one of the known multipliers, never < 1, symmetric", () => {
    fc.assert(
      fc.property(geoArb, geoArb, (a, b) => {
        const g = geoFactor(a, b);
        expect([1, 1.05, 1.1, 1.15]).toContain(g);
        expect(geoFactor(b, a)).toBe(g);
      }),
    );
  });

  it("score is bounded by similarity*1.11*1.15, non-negative, monotone in similarity and trust", () => {
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: 0, max: 0.5, noNaN: true }), sigArb, geoArb, (sim, d, s, g) => {
        const m = matchScore(sim, s, g);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(Math.max(0, sim) * 1.11 * 1.15 + 1e-9);
        expect(matchScore(sim + d, s, g)).toBeGreaterThanOrEqual(m - 1e-9);
        expect(matchScore(sim, { ...s, trustScore: s.trustScore + 10 }, g)).toBeGreaterThanOrEqual(m - 1e-9);
      }),
    );
  });
});

describe("rankCandidates / assignSlots properties", () => {
  const candsArb = fc.array(
    fc.record({ sellerBusinessId: fc.constantFrom("a", "b", "c", "d", "e", "f", "g"), listingId: fc.uuid(), similarity: fc.double({ min: 0, max: 1, noNaN: true }) }),
    { maxLength: 15 },
  );
  const profsArb = fc.array(fc.tuple(fc.constantFrom("a", "b", "c", "d", "e", "f"), sigArb), { maxLength: 6 }).map((x) => new Map<string, SellerSignals>(x));

  it("sorted desc, unique sellers, only profiled and non-excluded, preferred first when eligible", () => {
    fc.assert(
      fc.property(candsArb, profsArb, geoArb, fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 3 }), fc.option(fc.constantFrom("a", "b", "c", "d", "g"), { nil: null }), (cands: Candidate[], profs, geo, exclude: string[], pref: string | null) => {
        const r = rankCandidates(cands, profs, geo, { exclude, preferredSellerId: pref });
        const ids = r.map((x) => x.sellerBusinessId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
          expect(profs.has(id)).toBe(true);
          expect(exclude).not.toContain(id);
        }
        const body = pref && ids[0] === pref ? r.slice(1) : r;
        for (let i = 1; i < body.length; i++) expect(body[i - 1]!.matchScore).toBeGreaterThanOrEqual(body[i]!.matchScore);
        const eligible = cands.some((c) => c.sellerBusinessId === pref && profs.has(pref!) && !exclude.includes(pref!));
        if (pref && eligible) expect(ids[0]).toBe(pref);
      }),
    );
  });

  it("assignSlots never exceeds cap, reuses no active rank, fills lowest free ranks", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.integer({ min: 1, max: 6 }), fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 6 }), fc.integer({ min: 0, max: 8 }), (id, cap, activeRaw, n) => {
        const active = [...new Set(activeRaw.filter((r) => r <= cap))];
        const ranked = Array.from({ length: n }, (_, i) => ({ sellerBusinessId: `s${i}`, listingId: id, similarity: 1, matchScore: 1 - i / 100 }));
        const out = assignSlots(ranked, active, cap);
        const ranks = out.map((o) => o.rank);
        expect(new Set(ranks).size).toBe(ranks.length);
        expect(active.length + out.length).toBeLessThanOrEqual(cap);
        for (const r of ranks) {
          expect(r).toBeGreaterThanOrEqual(1);
          expect(r).toBeLessThanOrEqual(cap);
          expect(active).not.toContain(r);
        }
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(out.length).toBe(Math.min(n, cap - active.length));
        out.forEach((o, i) => expect(o.candidate.sellerBusinessId).toBe(`s${i}`));
      }),
    );
  });
});

describe("input schemas", () => {
  const ok = { title: "Boxes 3 ply", requirement: "Need 500 boxes urgently" };
  it("normalises blanks to null and applies defaults", () => {
    const p = enquiryInputSchema.parse({ ...ok, categorySlug: "", quantity: null, deliveryPincode: null, neededBy: null });
    expect(p).toMatchObject({ categorySlug: null, quantity: null, quantityUnit: null, targetPricePaise: null, deliveryCity: null, language: "en", buyerPicks: false, preferredListingId: null });
  });
  it("rejects short/long text, bad pincode, non-integer/negative numbers, bad dates, bad uuid", () => {
    const bad: Record<string, unknown>[] = [
      { title: "abc" }, { title: "x".repeat(141) }, { requirement: "short" }, { requirement: "x".repeat(4001) },
      { deliveryPincode: "012345" }, { deliveryPincode: "12345" }, { deliveryPincode: "12345a" },
      { quantity: 0 }, { quantity: 1.5 }, { quantity: -1 }, { targetPricePaise: 0 }, { neededBy: "not-a-date" }, { preferredListingId: "nope" },
    ];
    for (const b of bad) expect(enquiryInputSchema.safeParse({ ...ok, ...b }).success, JSON.stringify(b)).toBe(false);
    expect(enquiryInputSchema.safeParse({ ...ok, deliveryPincode: "560001", neededBy: "2026-12-01", quantity: 5 }).success).toBe(true);
  });
  it("trims titles; any whitespace-padded valid input parses to trimmed text", () => {
    fc.assert(fc.property(fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.trim().length >= 5), (t) => {
      expect(enquiryInputSchema.parse({ ...ok, title: `  ${t}  ` }).title).toBe(t.trim());
    }));
  });
  it("quote schema bounds", () => {
    const q = { pricePaise: 100, quantity: 1, unit: "pcs" };
    expect(quoteSchema.parse({ ...q, notes: "", leadTimeDays: undefined })).toMatchObject({ notes: null, leadTimeDays: null, validUntil: null });
    for (const b of [{ pricePaise: 0 }, { quantity: 0 }, { unit: " " }, { leadTimeDays: -1 }, { leadTimeDays: 731 }, { validUntil: "zzz" }, { notes: "x".repeat(2001) }, { pricePaise: 1.5 }])
      expect(quoteSchema.safeParse({ ...q, ...b }).success, JSON.stringify(b)).toBe(false);
  });
  it("message schema trims and bounds", () => {
    expect(messageSchema.parse("  hi  ")).toBe("hi");
    expect(messageSchema.safeParse("   ").success).toBe(false);
    expect(messageSchema.safeParse("x".repeat(4001)).success).toBe(false);
    expect(messageSchema.safeParse("x".repeat(4000)).success).toBe(true);
  });
});
