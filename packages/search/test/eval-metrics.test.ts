import fc from "fast-check";
import { describe, expect, it } from "vitest";
import judgements from "../eval/judgements.json";
import { dcgAtK, evaluateRun, ndcgAtK, reciprocalRank, type Judgement } from "../src/eval/metrics";

describe("nDCG@k", () => {
  it("is 1 for the ideal order and lower for a worse order (hand-computed)", () => {
    const rel = { a: 3, b: 2, c: 1 };
    expect(ndcgAtK(["a", "b", "c"], rel)).toBeCloseTo(1, 10);
    // DCG(b,a,c)=3/log2(2)+7/log2(3)+1/log2(4)=3+4.4165+0.5 ; ideal=7+3/log2(3)+0.5
    const dcg = 3 + 7 / Math.log2(3) + 1 / 2;
    const ideal = 7 + 3 / Math.log2(3) + 1 / 2;
    expect(ndcgAtK(["b", "a", "c"], rel)).toBeCloseTo(dcg / ideal, 10);
    expect(ndcgAtK(["x", "y", "a"], rel)).toBeCloseTo(7 / Math.log2(4) / ideal, 10);
  });
  it("is 0 with no relevant items or no results, and dedupes repeated ids", () => {
    expect(ndcgAtK(["a"], {})).toBe(0);
    expect(ndcgAtK(["a"], { a: 0 })).toBe(0);
    expect(ndcgAtK([], { a: 3 })).toBe(0);
    expect(ndcgAtK(["a", "a", "a"], { a: 3 })).toBeCloseTo(1, 10);
  });
  it("cuts off at k", () => {
    const ranked = [...Array.from({ length: 10 }, (_, i) => `n${i}`), "a"];
    expect(ndcgAtK(ranked, { a: 3 }, 10)).toBe(0);
    expect(ndcgAtK(ranked, { a: 3 }, 11)).toBeGreaterThan(0);
  });
  it("dcgAtK ignores negative grades and short lists", () => {
    expect(dcgAtK([-1, 2], 5)).toBeCloseTo(3 / Math.log2(3), 10);
    expect(dcgAtK([], 5)).toBe(0);
  });
  it("property: always within [0,1] and the ideal ordering scores 1", () => {
    const grades = fc.dictionary(fc.constantFrom("a", "b", "c", "d", "e"), fc.integer({ min: 0, max: 3 }));
    fc.assert(
      fc.property(fc.shuffledSubarray(["a", "b", "c", "d", "e", "f", "g"]), grades, (ranked, rel) => {
        const n = ndcgAtK(ranked, rel);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1 + 1e-12);
        const ideal = Object.entries(rel).filter(([, g]) => g > 0).sort((x, y) => y[1] - x[1]).map(([id]) => id);
        if (ideal.length) expect(ndcgAtK(ideal, rel)).toBeCloseTo(1, 10);
      }),
    );
  });
});

describe("reciprocal rank / evaluateRun", () => {
  it("is 1/rank of the first relevant result", () => {
    expect(reciprocalRank(["x", "a"], { a: 1 })).toBe(0.5);
    expect(reciprocalRank(["x", "x", "a"], { a: 1 })).toBe(0.5); // duplicate ids collapse
    expect(reciprocalRank(["a"], { a: 1 })).toBe(1);
    expect(reciprocalRank(["x"], { a: 1 })).toBe(0);
    expect(reciprocalRank([], {})).toBe(0);
  });
  it("means over queries, treats a missing run as no results", () => {
    const js: Judgement[] = [
      { id: "1", query: "q1", lang: "en", relevant: { a: 3 } },
      { id: "2", query: "q2", lang: "hi", relevant: { b: 3 } },
      { id: "3", query: "q3", lang: "hi", relevant: { c: 3 } },
    ];
    const r = evaluateRun(js, { "1": ["a"], "2": ["x", "b"] });
    expect(r.queries).toBe(3);
    expect(r.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
    expect(r.hitRate10).toBeCloseTo(2 / 3, 10);
    expect(r.ndcg10).toBeCloseTo((1 + 1 / Math.log2(3) + 0) / 3, 10);
    expect(evaluateRun([], {})).toMatchObject({ queries: 0, ndcg10: 0, mrr: 0 });
  });
});

describe("judgement set integrity (real data will replace it, the shape must hold)", () => {
  const cat = (judgements as { catalogue: Record<string, { category: string; titles: string[] }> }).catalogue;
  const qs = (judgements as unknown as { queries: Judgement[] }).queries;
  it("has at least 60 queries across English, Hinglish, Hindi and other scripts, with unique ids", () => {
    expect(qs.length).toBeGreaterThanOrEqual(60);
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    const langs = new Set(qs.map((q) => q.lang));
    for (const l of ["en", "hinglish", "hi", "kn", "ta", "te", "gu", "bn", "mr"]) expect(langs.has(l)).toBe(true);
  });
  it("references only known product-line slugs with grades 1..3", () => {
    for (const q of qs) {
      expect(Object.keys(q.relevant).length).toBeGreaterThan(0);
      for (const [slug, g] of Object.entries(q.relevant)) {
        expect(cat[slug], `${q.id}:${slug}`).toBeTruthy();
        expect([1, 2, 3]).toContain(g);
      }
    }
  });
});
