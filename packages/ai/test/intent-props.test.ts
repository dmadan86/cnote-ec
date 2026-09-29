import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scoreIntentHeuristic, specMatches } from "../src/heuristic/intent";

const NOW = new Date("2026-06-01T00:00:00Z");
const base = { title: "Boxes", requirement: "Need corrugated boxes for shipping garments", buyerVerificationTier: 0, buyerPhoneVerified: false, buyerPriorEnquiries: 0, buyerPriorResponded: 0 };
const score = (o: object) => scoreIntentHeuristic({ ...base, ...o }, NOW).output.score;

const inputArb = fc.record({
  title: fc.string({ maxLength: 60 }),
  requirement: fc.string({ maxLength: 300 }),
  quantity: fc.option(fc.integer({ min: -5, max: 1e6 }), { nil: null }),
  quantityUnit: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  targetPricePaise: fc.option(fc.integer({ min: -100, max: 2e9 }), { nil: null }),
  deliveryPincode: fc.option(fc.oneof(fc.string({ maxLength: 8 }), fc.stringMatching(/^[1-9][0-9]{5}$/)), { nil: null }),
  neededBy: fc.option(fc.oneof(fc.constant("garbage"), fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map((d) => d.toISOString())), { nil: null }),
  buyerVerificationTier: fc.integer({ min: -2, max: 9 }),
  buyerPhoneVerified: fc.boolean(),
  buyerPriorEnquiries: fc.integer({ min: 0, max: 50 }),
  buyerPriorResponded: fc.integer({ min: 0, max: 80 }),
  nearDuplicateSimilarity: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
});

describe("intent heuristic properties", () => {
  it("always bounded 0-100 integer, confidence 0.35-1, <= 8 reasons, deterministic", () =>
    fc.assert(fc.property(inputArb, (i) => {
      const a = scoreIntentHeuristic(i, NOW);
      const b = scoreIntentHeuristic(i, NOW);
      expect(a).toEqual(b);
      expect(Number.isInteger(a.output.score)).toBe(true);
      expect(a.output.score).toBeGreaterThanOrEqual(0);
      expect(a.output.score).toBeLessThanOrEqual(100);
      expect(a.confidence).toBeGreaterThanOrEqual(0.35);
      expect(a.confidence).toBeLessThanOrEqual(1);
      expect(a.output.reasons.length).toBeLessThanOrEqual(8);
      expect(a.provider).toBe("heuristic");
    }), { numRuns: 400 }));

  it("adding specificity never lowers the score (quantity, unit, pincode, timeline, price, phone, tier)", () =>
    fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 3 }), (q, tier) => {
      const s0 = score({});
      const s1 = score({ quantity: q });
      const s2 = score({ quantity: q, quantityUnit: "pieces" });
      const s3 = score({ quantity: q, quantityUnit: "pieces", deliveryPincode: "560001" });
      const s4 = score({ quantity: q, quantityUnit: "pieces", deliveryPincode: "560001", neededBy: "2026-06-20T00:00:00Z" });
      const s5 = score({ quantity: q, quantityUnit: "pieces", deliveryPincode: "560001", neededBy: "2026-06-20T00:00:00Z", targetPricePaise: 50_000 });
      const s6 = score({ quantity: q, quantityUnit: "pieces", deliveryPincode: "560001", neededBy: "2026-06-20T00:00:00Z", targetPricePaise: 50_000, buyerPhoneVerified: true });
      const s7 = score({ quantity: q, quantityUnit: "pieces", deliveryPincode: "560001", neededBy: "2026-06-20T00:00:00Z", targetPricePaise: 50_000, buyerPhoneVerified: true, buyerVerificationTier: tier });
      const seq = [s0, s1, s2, s3, s4, s5, s6, s7];
      for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
    })));

  it("appending a spec phrase to the requirement never lowers the score", () =>
    fc.assert(fc.property(fc.constantFrom("180 gsm", "3 ply", "10x10x5", "SS304", "grade a", "size 12", "12mm"), (spec) => {
      expect(score({ requirement: `${base.requirement} ${spec}` })).toBeGreaterThanOrEqual(score({}));
    })));

  it("higher verification tier never lowers the score (tier clamps at 3)", () =>
    fc.assert(fc.property(fc.integer({ min: -3, max: 8 }), (t) => {
      expect(score({ buyerVerificationTier: t + 1 })).toBeGreaterThanOrEqual(score({ buyerVerificationTier: t }));
    })));

  it.each([
    ["a link", "Need boxes, see https://spam.example.com/offer for details please"],
    ["a phone number", "Need boxes urgently please call 9876543210 for the details"],
    ["an email", "Need boxes for shipping, mail me at someone@example.com for details"],
    ["all caps", "NEED CORRUGATED BOXES FOR GARMENT SHIPPING URGENTLY NOW"],
    ["gibberish", "qwrtp zxcvbnm bcdfgh xkcdqw hjklmn qwrtpsd fghjkl"],
  ])("spam signal lowers the score: %s", (_n, requirement) => {
    const clean = score({ requirement: "Need corrugated boxes for shipping garments to our warehouse" });
    expect(score({ requirement })).toBeLessThan(clean);
  });
  it("very short text is penalised", () => expect(score({ requirement: "boxes" })).toBeLessThan(score({ requirement: "need boxes for shipping" })));
  it("near duplicates are penalised, more similar is worse", () => {
    const rich = { quantity: 500, quantityUnit: "pcs", deliveryPincode: "560001", buyerPhoneVerified: true, buyerVerificationTier: 3 };
    const a = score({ ...rich, nearDuplicateSimilarity: 0.5 }), b = score({ ...rich, nearDuplicateSimilarity: 0.86 }), c = score({ ...rich, nearDuplicateSimilarity: 0.95 });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
  it("implausible target price is penalised vs plausible", () => {
    const rich = { quantity: 500, deliveryPincode: "560001", buyerPhoneVerified: true, buyerVerificationTier: 2 };
    expect(score({ ...rich, targetPricePaise: 50 })).toBeLessThan(score({ ...rich, targetPricePaise: 50_000 }));
    expect(score({ ...rich, targetPricePaise: 5e9 })).toBeLessThan(score({ ...rich, targetPricePaise: 50_000 }));
  });
  it("prior enquiries: responsive buyers beat ghosts; only >=3 enquiries with <30% response penalise", () => {
    const good = scoreIntentHeuristic({ ...base, buyerPriorEnquiries: 5, buyerPriorResponded: 5 }, NOW);
    const ghost = scoreIntentHeuristic({ ...base, buyerPriorEnquiries: 5, buyerPriorResponded: 0 }, NOW);
    expect(good.output.score).toBeGreaterThan(ghost.output.score);
    expect(ghost.output.reasons.some((r) => r.includes("only 0 of 5"))).toBe(true);
    const few = scoreIntentHeuristic({ ...base, buyerPriorEnquiries: 2, buyerPriorResponded: 0 }, NOW);
    expect(few.output.reasons.some((r) => r.includes("only"))).toBe(false);
    expect(good.output.reasons.some((r) => r.includes("Engaged with sellers on 5 of 5"))).toBe(true);
  });
  it("neededBy: bands, past and invalid dates", () => {
    const r = (neededBy: string) => scoreIntentHeuristic({ ...base, neededBy }, NOW).output;
    expect(r("2026-06-11T00:00:00Z").reasons).toContain("Needed within 10 days");
    expect(r("2026-06-01T12:00:00Z").reasons).toContain("Needed within 1 day");
    expect(r("2026-08-30T00:00:00Z").reasons).toContain("Delivery timeline provided");
    expect(r("2027-06-01T00:00:00Z").reasons).toContain("Delivery timeline provided");
    expect(r("2025-01-01T00:00:00Z").reasons).toContain("Needed-by date has already passed");
    expect(r("not a date").reasons).toContain("Needed-by date is invalid");
    const s = (d: string) => scoreIntentHeuristic({ ...base, neededBy: d }, NOW).output.score;
    expect(s("2026-06-11T00:00:00Z")).toBeGreaterThan(s("2026-08-30T00:00:00Z"));
    expect(s("2026-08-30T00:00:00Z")).toBeGreaterThan(s("2027-06-01T00:00:00Z"));
  });
  it("default `now` works", () => expect(scoreIntentHeuristic(base).output.score).toBeGreaterThanOrEqual(0));
  it("strong buyer input never exceeds 100", () => {
    const r = scoreIntentHeuristic({ ...base, requirement: "Need 3 ply boxes 10x10x5 cm 180 gsm grade a SS304 size 12 dia 5 for garment packaging shipments", quantity: 5000, quantityUnit: "pcs", deliveryPincode: "400001", neededBy: "2026-06-05T00:00:00Z", targetPricePaise: 9000, buyerVerificationTier: 3, buyerPhoneVerified: true, buyerPriorEnquiries: 10, buyerPriorResponded: 10 }, NOW);
    expect(r.output.score).toBeLessThanOrEqual(100);
    expect(r.output.score).toBeGreaterThan(80);
  });
});

describe("specMatches", () => {
  it.each([["180 gsm", 1], ["10x10x5", 1], ["SS304 pipe", 1], ["IS 2062", 1], ["dia 25", 1], ["nothing here", 0]])("%j -> %i", (t, n) => expect(specMatches(t).length).toBeGreaterThanOrEqual(n));
  it("nothing for spec-free text", () => expect(specMatches("hello world")).toEqual([]));
  it("never throws on arbitrary text", () => fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => { specMatches(s); })));
});
