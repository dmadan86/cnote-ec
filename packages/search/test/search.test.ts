import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
vi.mock("@cnote/core", () => ({
  cached: async (_k: string, _t: number, load: () => Promise<unknown>) => load(),
  cachedTagged: async (_k: string, _tags: unknown, _t: number, load: () => Promise<unknown>) => load(),
  cacheTags: { search: "search", categories: "categories", category: (s: string) => `category:${s}`, listing: (i: string) => `listing:${i}`, seller: (i: string) => `seller:${i}` },
}));
vi.mock("@cnote/ai", () => ({ embed: async () => ({ vectors: [[0.1]], version: "v" }) }));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  retrieveListings: (o: unknown) => retrieve(o),
  getPublicListingsByIds: async (ids: string[]) => ids.map((id) => ({ id })),
  listCategories: async () => [],
  suggestListingTitles: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async () =>
    new Map([
      ["s-hi", { businessId: "s-hi", city: "Surat", trustScore: 95, badgeActive: true }],
      ["s-lo", { businessId: "s-lo", city: "Tiruppur", trustScore: 20, badgeActive: false }],
    ]),
}));

const { searchListings } = await import("../src/search");
const { suggest, EXAMPLE_QUERIES } = await import("../src/suggest");

beforeEach(() => retrieve.mockReset());

describe("searchListings", () => {
  it("fuses, applies trust, labels non-sponsored, drops sellers without a profile", async () => {
    retrieve.mockResolvedValue([
      { listingId: "a", sellerBusinessId: "s-lo", lexicalRank: 0.5, similarity: 0.7 },
      { listingId: "b", sellerBusinessId: "s-hi", lexicalRank: 0.5, similarity: 0.7 },
      { listingId: "c", sellerBusinessId: "ghost", lexicalRank: 0.9, similarity: 0.9 },
    ]);
    const r = await searchListings({ q: "Cotton shirts chahiye" });
    expect(retrieve.mock.calls[0]![0].text).toBe("cotton shirts");
    expect(r.hits.map((h) => h.listing.id)).toEqual(["b", "a"]);
    expect(r.hits.every((h) => h.sponsored === false)).toBe(true);
    expect(typeof r.tookMs).toBe("number");
  });
  it("location hint boosts a matching city", async () => {
    retrieve.mockResolvedValue([
      { listingId: "a", sellerBusinessId: "s-lo", lexicalRank: 0.5, similarity: 0.7 },
      { listingId: "b", sellerBusinessId: "s-hi", lexicalRank: 0.5, similarity: 0.7 },
    ]);
    const plain = await searchListings({ q: "shirts" });
    const boosted = await searchListings({ q: "shirts in Tiruppur" });
    const s = (r: typeof plain, id: string) => r.hits.find((h) => h.listing.id === id)!.score;
    expect(s(boosted, "a")).toBeGreaterThan(s(plain, "a"));
  });
});

describe("suggest", () => {
  it("returns example chips for empty prefix and matches by word prefix", async () => {
    expect(await suggest("")).toEqual(EXAMPLE_QUERIES);
    expect(await suggest("pack")).toContain("Packaging boxes for cosmetics");
    expect(await suggest("furn")).toEqual(["Office furniture suppliers"]);
  });
});
