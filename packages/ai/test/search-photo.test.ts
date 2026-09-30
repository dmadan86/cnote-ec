import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveImageSearch, deriveSearchQuery, MAX_PHOTO_KEYWORDS, setProvidersForTests, heuristicProviders } from "../src";
import { syntheticPng } from "../evals/fixtures";

const base = { title: "Red Corrugated Box", categorySlug: "boxes", detected: { productType: "box", quantityVisible: null }, visualAttributes: { colour: "red", material: "kraft" } as Record<string, string> };
const img = () => ({ bytes: syntheticPng(64, 48, "checker", [200, 30, 30]), mimeType: "image/png", width: 64, height: 48 });

afterEach(() => setProvidersForTests(null));

describe("deriveSearchQuery", () => {
  it("orders product type, title words then attributes, deduped and capped", () => {
    const r = deriveSearchQuery(base, ["boxes"]);
    expect(r.keywords).toEqual(["box", "red", "corrugated", "kraft"]);
    expect(r.query).toBe("box red corrugated kraft");
    expect(r.categorySlug).toBe("boxes");
  });
  it("caps keywords and ignores unknown categories", () => {
    const r = deriveSearchQuery({ ...base, title: "a1 b2 c3 d4 e5 f6 g7 h8" }, ["other"]);
    expect(r.keywords).toHaveLength(MAX_PHOTO_KEYWORDS);
    expect(r.categorySlug).toBeNull();
  });
  it("returns an empty query for the placeholder title and no product type", () => {
    const r = deriveSearchQuery({ title: "Untitled product", categorySlug: null, detected: { productType: "", quantityVisible: null }, visualAttributes: {} });
    expect(r).toEqual({ query: "", keywords: [], categorySlug: null });
  });
  it("works without an offered-category list", () => {
    expect(deriveSearchQuery({ ...base, categorySlug: null }).categorySlug).toBeNull();
    expect(deriveSearchQuery(base).categorySlug).toBeNull();
  });
});

describe("deriveImageSearch", () => {
  it("uses only the first photo and reports the decision", async () => {
    const seen: number[] = [];
    setProvidersForTests({
      ...heuristicProviders,
      imageExtractor: { extract: async (i) => { seen.push(i.images.length); return { output: { title: "Steel Bottle", description: "", categorySlug: "home", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, visualAttributes: {}, detected: { productType: "bottle", quantityVisible: null } }, confidence: 0.9, provider: "t", modelId: "m", promptVersion: "v" }; } },
    });
    const r = await deriveImageSearch({ images: [img(), img()], language: "en", categories: [{ slug: "home", name: "Home", attributeSchema: {} }] }, { type: "listing", id: randomUUID() });
    expect(seen).toEqual([1]);
    expect(r).toMatchObject({ query: "bottle steel", categorySlug: "home", confidence: 0.9, needsReview: false });
    expect(r.decisionId).toBeTruthy();
  });
  it("offline heuristic without a hint yields an empty query", async () => {
    const r = await deriveImageSearch({ images: [img()], language: "en", categories: [] }, { type: "listing", id: randomUUID() });
    expect(r.query).toBe("");
    expect(r.needsReview).toBe(true);
  });
});
