import { afterEach, describe, expect, it } from "vitest";
import { fusionWeights, INDIC_LEXICAL_WEIGHT, rrfFuse } from "../src/fusion";
import { indicLexicalWeight, latinBlend, semanticBlend } from "../src/search";
import { bestLatinVariant, blendVectors, planSemantic } from "../src/semantic";
import { expandQuery } from "../src/translit/variants";

describe("semantic query planning (search-v2 limitation 3)", () => {
  it("leaves Latin queries untouched", () => {
    expect(planSemantic("office chair", ["office chair x"])).toEqual({ texts: ["office chair"], weights: [1] });
    expect(bestLatinVariant("office chair", ["chair"])).toBeNull();
  });
  it("embeds the Latin variant for Indic and mixed-script queries", () => {
    const text = "cotton कपड़ा";
    const variants = expandQuery(text);
    expect(bestLatinVariant(text, variants)).toBe(variants.find((v) => !/[ऀ-෿]/u.test(v)));
    expect(planSemantic(text, variants).texts).toEqual([bestLatinVariant(text, variants)]);
    expect(planSemantic("चावल", expandQuery("चावल")).texts[0]).toMatch(/^[a-z ]+$/);
  });
  it("falls back to the original when no Latin variant exists and skips blank ones", () => {
    expect(bestLatinVariant("चावल", ["  ", "चावल x"])).toBeNull();
    expect(planSemantic("चावल", [])).toEqual({ texts: ["चावल"], weights: [1] });
  });
  it("blends the original at the given weight", () => {
    expect(planSemantic("चावल", ["rice"], 0.25)).toEqual({ texts: ["rice", "चावल"], weights: [0.75, 0.25] });
    expect(planSemantic("चावल", ["rice"], 0)).toEqual({ texts: ["rice"], weights: [1] });
  });
  it("blends Latin queries with their canonicalised variant only when asked", () => {
    expect(planSemantic("kursi", ["chair"], 0, 0.5)).toEqual({ texts: ["kursi", "chair"], weights: [0.5, 0.5] });
    expect(planSemantic("kursi", ["chair"])).toEqual({ texts: ["kursi"], weights: [1] });
    expect(planSemantic("kursi", ["कुर्सी"], 0, 0.5)).toEqual({ texts: ["kursi"], weights: [1] });
  });
  it("blendVectors returns a unit vector and handles empty input", () => {
    const v = blendVectors([[1, 0], [0, 1]], [0.5, 0.5]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(v[0]).toBeCloseTo(v[1]!);
    expect(blendVectors([], [])).toEqual([]);
    expect(blendVectors([[0, 0]], [1])).toEqual([0, 0]);
    expect(blendVectors([[1, 0], [0, 1]], [1])[1]).toBeCloseTo(0); // missing weight counts as 0
    expect(blendVectors([[1, 0], [0]], [0.5, 0.5])).toHaveLength(2);
  });
});

describe("script-aware fusion weights", () => {
  it("down-weights lexical only for Indic queries with transliteration on", () => {
    expect(fusionWeights("चावल", true)).toEqual([INDIC_LEXICAL_WEIGHT, 1]);
    expect(fusionWeights("cotton कपड़ा", true, 0.7)).toEqual([0.7, 1]);
    expect(fusionWeights("rice", true)).toEqual([1, 1]);
    expect(fusionWeights("चावल", false)).toEqual([1, 1]);
  });
  it("rrfFuse weights shift the ranking and stay normalised to 0..1", () => {
    const c = [
      { listingId: "lex", sellerBusinessId: "s", lexicalRank: 2, similarity: 0.2 },
      { listingId: "vec", sellerBusinessId: "s", lexicalRank: 1, similarity: 0.9 },
    ];
    const even = rrfFuse(c);
    const semantic = rrfFuse(c, undefined, 0.2, 1);
    expect(even.get("lex")).toBeCloseTo(even.get("vec")!);
    expect(semantic.get("vec")!).toBeGreaterThan(semantic.get("lex")!);
    expect(Math.max(...semantic.values())).toBeLessThanOrEqual(1);
  });
});

describe("env knobs", () => {
  const keys = ["SEARCH_SEMANTIC_BLEND", "SEARCH_LATIN_BLEND", "SEARCH_INDIC_LEX_WEIGHT"] as const;
  afterEach(() => keys.forEach((k) => delete process.env[k]));
  it("defaults, clamps and ignores junk", () => {
    expect([semanticBlend(), latinBlend(), indicLexicalWeight()]).toEqual([0, 0, INDIC_LEXICAL_WEIGHT]);
    process.env.SEARCH_SEMANTIC_BLEND = "0.3"; process.env.SEARCH_LATIN_BLEND = "9"; process.env.SEARCH_INDIC_LEX_WEIGHT = "99";
    expect([semanticBlend(), latinBlend(), indicLexicalWeight()]).toEqual([0.3, 1, 5]);
    process.env.SEARCH_SEMANTIC_BLEND = "abc"; process.env.SEARCH_LATIN_BLEND = "x"; process.env.SEARCH_INDIC_LEX_WEIGHT = "-1";
    expect([semanticBlend(), latinBlend(), indicLexicalWeight()]).toEqual([0, 0, INDIC_LEXICAL_WEIGHT]);
    process.env.SEARCH_SEMANTIC_BLEND = "";
    expect(semanticBlend()).toBe(0);
  });
});
