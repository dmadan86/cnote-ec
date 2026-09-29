import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LOCATION_BOOST, MIN_SIMILARITY, RRF_K, locationBoost, rrfFuse, toCandidates, trustFactor } from "../src/fusion";
import { normaliseQuery } from "../src/normalise";

describe("normaliseQuery table", () => {
  const table: [string, string, string | null][] = [
    ["", "", null],
    ["   ", "", null],
    ["BOXES", "boxes", null],
    ["ＢＯＸＥＳ", "boxes", null], // NFKC fullwidth
    ["boxes!!! @@ ###", "boxes", null],
    ["mujhe cotton saree chahiye", "cotton saree", null],
    ["please need bulk rice", "bulk rice", null],
    ["rice in bulk", "rice in bulk", null],
    ["steel pipes near Pune", "steel pipes", "pune"],
    ["steel pipes from Rajkot", "steel pipes", "rajkot"],
    ["gift items at New Delhi", "gift items", "new delhi"],
    ["chairs in Bharat", "chairs", null],
    ["bolts in wholesale", "bolts in wholesale", null],
    ["kurta wala in Jaipur", "kurta", "jaipur"],
    ["LED lights ke liye supplier", "led lights supplier", null],
    ["m&m's 3/4\" pipe+fitting", "m&m's 3/4 pipe+fitting", null],
  ];
  it.each(table)("%j -> text %j, location %j", (raw, text, location) => {
    expect(normaliseQuery(raw)).toEqual({ text, location });
  });
  it("truncates to 200 chars", () => expect(normaliseQuery("a".repeat(500)).text.length).toBeLessThanOrEqual(200));
  it("handles Devanagari without dropping letters", () => expect(normaliseQuery("कपड़े चाहिए").text).not.toBe(""));
});

describe("normaliseQuery properties", () => {
  it("never throws on arbitrary unicode and returns a bounded string", () =>
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 400 }), (s) => {
      const r = normaliseQuery(s);
      expect(r.text.length).toBeLessThanOrEqual(200);
      expect(r.text).toBe(r.text.trim());
      expect(r.text).not.toMatch(/\s{2,}/);
    })));
  it("is idempotent on the text part (no location)", () =>
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 120 }), (s) => {
      const once = normaliseQuery(s);
      const twice = normaliseQuery(once.text);
      fc.pre(once.location === null);
      expect(twice.text).toBe(once.text);
    }), { numRuns: 300 }));
  it("is case/whitespace-insensitive", () =>
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 6 }), (w) => {
      expect(normaliseQuery(w.join("   ").toUpperCase())).toEqual(normaliseQuery(w.join(" ")));
    })));
});

describe("rrfFuse properties", () => {
  const cand = fc.record({
    lexicalRank: fc.oneof(fc.constant(0), fc.double({ min: 0.001, max: 100, noNaN: true })),
    similarity: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 1, noNaN: true })),
  });
  const cands = fc.array(cand, { minLength: 0, maxLength: 30 }).map((a) => a.map((c, i) => ({ ...c, listingId: `l${i}`, sellerBusinessId: "s" })));

  it("scores are in (0,1]", () =>
    fc.assert(fc.property(cands, (cs) => {
      for (const v of rrfFuse(cs).values()) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(1 + 1e-12); }
    })));
  it("input order does not change scores when scores are distinct", () =>
    fc.assert(fc.property(cands, (cs) => {
      const lex = new Set(cs.map((c) => c.lexicalRank).filter((x) => x > 0));
      const sim = new Set(cs.map((c) => c.similarity).filter((x) => x >= MIN_SIMILARITY));
      fc.pre(lex.size === cs.filter((c) => c.lexicalRank > 0).length && sim.size === cs.filter((c) => c.similarity >= MIN_SIMILARITY).length);
      const a = rrfFuse(cs);
      const b = rrfFuse([...cs].reverse());
      for (const [k, v] of a) expect(b.get(k)).toBeCloseTo(v, 12);
      expect(b.size).toBe(a.size);
    })));
  it("monotone: a strictly better lexical score never lowers the fused score", () =>
    fc.assert(fc.property(cands, fc.nat(29), (cs, idx) => {
      fc.pre(cs.length > 0);
      const i = idx % cs.length;
      const before = rrfFuse(cs).get(cs[i]!.listingId) ?? 0;
      const boosted = cs.map((c, j) => (j === i ? { ...c, lexicalRank: 1e6 } : c));
      expect(rrfFuse(boosted).get(cs[i]!.listingId)!).toBeGreaterThanOrEqual(before - 1e-12);
    })));
  it("monotone: a better similarity never lowers the fused score", () =>
    fc.assert(fc.property(cands, fc.nat(29), (cs, idx) => {
      fc.pre(cs.length > 0);
      const i = idx % cs.length;
      const before = rrfFuse(cs).get(cs[i]!.listingId) ?? 0;
      const boosted = cs.map((c, j) => (j === i ? { ...c, similarity: 1 } : c));
      expect(rrfFuse(boosted).get(cs[i]!.listingId)!).toBeGreaterThanOrEqual(before - 1e-12);
    })));
  it("ranks match single-list order; ties impossible to invert rank-1", () => {
    const f = rrfFuse([
      { listingId: "a", sellerBusinessId: "s", lexicalRank: 3, similarity: 0 },
      { listingId: "b", sellerBusinessId: "s", lexicalRank: 2, similarity: 0 },
    ]);
    expect(f.get("a")!).toBeCloseTo((1 / (RRF_K + 1)) / (2 / (RRF_K + 1)));
    expect(f.get("a")!).toBeGreaterThan(f.get("b")!);
  });
  it("empty input gives empty map", () => expect(rrfFuse([]).size).toBe(0));
  it("toCandidates maps scores 1:1", () =>
    expect(toCandidates([{ listingId: "a", sellerBusinessId: "s", lexicalScore: 2, vectorScore: 0.3 }])).toEqual([{ listingId: "a", sellerBusinessId: "s", lexicalRank: 2, similarity: 0.3 }]));
});

describe("trustFactor", () => {
  it("bounded 0.6..1.03 and monotone for any number", () =>
    fc.assert(fc.property(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), fc.double({ noNaN: true, min: -1e6, max: 1e6 }), fc.boolean(), (a, b, badge) => {
      const fa = trustFactor({ trustScore: a, badgeActive: badge });
      expect(fa).toBeGreaterThanOrEqual(0.6 - 1e-12);
      expect(fa).toBeLessThanOrEqual(1.03 + 1e-12);
      if (a <= b) expect(trustFactor({ trustScore: b, badgeActive: badge })).toBeGreaterThanOrEqual(fa);
    })));
  it("ignores plan/payment fields even if smuggled in (never pay-to-rank)", () =>
    fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.boolean(), fc.string(), fc.integer(), (t, badge, plan, paid) => {
      const base = trustFactor({ trustScore: t, badgeActive: badge });
      const smuggled = trustFactor({ trustScore: t, badgeActive: badge, plan, planTier: paid, amountPaid: paid, sponsored: true } as any);
      expect(smuggled).toBe(base);
    })));
  it("source of fusion.ts never references plan/payment", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/fusion.ts", import.meta.url), "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/plan|payment|paid|sponsor|subscription/i);
  });
});

describe("locationBoost", () => {
  it("is 1 or LOCATION_BOOST only and case/space-insensitive on seller city", () => {
    expect(locationBoost("  TIRUPPUR ", "tiruppur")).toBe(LOCATION_BOOST);
    fc.assert(fc.property(fc.option(fc.string(), { nil: null }), fc.option(fc.string(), { nil: null }), (c, h) => {
      expect([1, LOCATION_BOOST]).toContain(locationBoost(c, h));
    }));
  });
});
