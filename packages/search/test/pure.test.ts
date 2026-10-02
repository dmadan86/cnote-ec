import { describe, expect, it } from "vitest";
import { MIN_SIMILARITY, locationBoost, rrfFuse, trustFactor } from "../src/fusion";
import { normaliseQuery } from "../src/normalise";

describe("normaliseQuery", () => {
  it("trims, collapses whitespace, lowercases", () => expect(normaliseQuery("  Cotton   T-Shirts ").text).toBe("cotton t-shirts"));
  it("strips Hinglish fillers", () => {
    expect(normaliseQuery("packaging boxes chahiye").text).toBe("packaging boxes");
    expect(normaliseQuery("cosmetic ke liye boxes wala").text).toBe("cosmetic boxes");
    expect(normaliseQuery("I need office chairs").text).toBe("i office chairs");
  });
  it("extracts a location hint", () => {
    expect(normaliseQuery("T-shirt suppliers in Tiruppur")).toEqual({ text: "t-shirt suppliers", location: "tiruppur" });
    expect(normaliseQuery("suppliers in Navi Mumbai").location).toBe("navi mumbai");
  });
  it("treats countries and generic tails as non-locations", () => {
    expect(normaliseQuery("T-shirts manufacturers in India")).toEqual({ text: "t-shirts manufacturers", location: null });
    expect(normaliseQuery("boxes in bulk").location).toBeNull();
  });
  it("is idempotent on punctuation next to a location keyword (fast-check counterexample)", () => {
    const once = normaliseQuery("in:A");
    expect(normaliseQuery(once.text).text).toBe(once.text);
  });
  it("never returns empty when the query was only filler", () => expect(normaliseQuery("chahiye").text).toBe("chahiye"));
});

describe("trustFactor", () => {
  it("orders by trust score and rewards badge, bounded", () => {
    const f = (trustScore: number, badgeActive = false) => trustFactor({ trustScore, badgeActive });
    expect(f(90)).toBeGreaterThan(f(50));
    expect(f(50)).toBeGreaterThan(f(10));
    expect(f(50, true)).toBeGreaterThan(f(50));
    expect(f(0)).toBeCloseTo(0.6);
    expect(f(500)).toBeCloseTo(1.0);
  });
  it("a much more trusted seller can outrank a slightly more relevant one, but not a far more relevant one", () => {
    expect(0.9 * trustFactor({ trustScore: 95, badgeActive: true })).toBeGreaterThan(1.0 * trustFactor({ trustScore: 20, badgeActive: false }));
    expect(0.3 * trustFactor({ trustScore: 100, badgeActive: true })).toBeLessThan(1.0 * trustFactor({ trustScore: 0, badgeActive: false }));
  });
});

describe("rrfFuse", () => {
  const c = (id: string, lexicalRank: number, similarity: number) => ({ listingId: id, sellerBusinessId: "s", lexicalRank, similarity });
  it("ranks items present in both lists above single-list items", () => {
    const f = rrfFuse([c("both", 0.5, 0.6), c("lexOnly", 0.9, 0), c("vecOnly", 0, 0.9)]);
    expect(f.get("both")!).toBeGreaterThan(f.get("lexOnly")!);
    expect(f.get("both")!).toBeGreaterThan(f.get("vecOnly")!);
  });
  it("normalises so rank-1-in-both is 1", () => expect(rrfFuse([c("a", 1, 0.9)]).get("a")).toBeCloseTo(1));
  it("ignores noise-level similarity and absent lexical", () => {
    const f = rrfFuse([c("noise", 0, MIN_SIMILARITY - 0.01)]);
    expect(f.has("noise")).toBe(false);
  });
});

describe("locationBoost", () => {
  it("boosts matching city only", () => {
    expect(locationBoost("Tiruppur", "tiruppur")).toBeGreaterThan(1);
    expect(locationBoost("Surat", "tiruppur")).toBe(1);
    expect(locationBoost(null, "tiruppur")).toBe(1);
    expect(locationBoost("Surat", null)).toBe(1);
  });
});
