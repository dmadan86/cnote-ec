import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/core", () => ({
  cachedTagged: async (_k: string, _tags: unknown, _ttl: number, load: () => Promise<unknown>) => load(),
  cacheTags: { search: "search", categories: "categories", category: (s: string) => `category:${s}`, listing: (i: string) => `listing:${i}`, seller: (i: string) => `seller:${i}` },
}));
vi.mock("@cnote/ai", () => ({ embed: async () => ({ vectors: [[0.1]], version: "v" }) }));

const CATS = [
  { id: "p", slug: "packaging", name: "Packaging", parentId: null },
  { id: "p1", slug: "boxes", name: "Boxes", parentId: "p" },
  { id: "p2", slug: "gift-boxes", name: "Gift boxes", parentId: "p1" },
  { id: "t", slug: "textiles", name: "Textiles", parentId: null },
];
type L = { id: string; pricePaise: number | null; moq: number | null; createdAt: string; category: { id: string } };
let listings: Record<string, L> = {};
let profiles: Record<string, any> = {};
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async (s: string) => CATS.find((c) => c.slug === s) ?? null,
  listCategories: async () => CATS,
  getPublicListingsByIds: async (ids: string[]) => ids.flatMap((i) => (listings[i] ? [listings[i]] : [])),
  suggestListingTitles: async () => [],
  retrieveListings: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.flatMap((i) => (profiles[i] ? [[i, profiles[i]]] : []))),
}));

const { searchListings } = await import("../src/search");
const { setSearchIndexForTests } = await import("../src/index-port/factory");

const searchFn = vi.fn();
const fake = () => ({ backend: "opensearch", search: searchFn, upsert: vi.fn(), remove: vi.fn(), health: vi.fn(), reindexAll: vi.fn() }) as any;
const hit = (id: string, seller: string, lex: number) => ({ listingId: id, sellerBusinessId: seller, lexicalScore: lex, vectorScore: 0.5 });
const prof = (id: string, o: object = {}) => ({ businessId: id, city: "Surat", state: "Gujarat", verificationTier: 1, trustScore: 50, badgeActive: false, ...o });

beforeEach(() => {
  searchFn.mockReset();
  setSearchIndexForTests(fake());
  listings = {
    a: { id: "a", pricePaise: 300_000, moq: 10, createdAt: "2026-01-01T00:00:00Z", category: { id: "p1" } },
    b: { id: "b", pricePaise: 100_000, moq: 500, createdAt: "2026-03-01T00:00:00Z", category: { id: "p1" } },
    c: { id: "c", pricePaise: null, moq: null, createdAt: "2026-02-01T00:00:00Z", category: { id: "p1" } },
  };
  profiles = { sa: prof("sa", { verificationTier: 3, trustScore: 60 }), sb: prof("sb", { verificationTier: 1, trustScore: 95 }), sc: prof("sc", { verificationTier: 2, trustScore: 70 }) };
  searchFn.mockResolvedValue({ hits: [hit("a", "sa", 3), hit("b", "sb", 2), hit("c", "sc", 1)], nextCursor: null });
});

const ids = async (opts: Parameters<typeof searchListings>[0]) => (await searchListings(opts)).hits.map((h) => h.listing.id);

describe("searchListings filters", () => {
  it("expands a category slug to its subcategories and never uses the legacy single-id path", async () => {
    await searchListings({ q: "box", categorySlug: "packaging" });
    const q = searchFn.mock.calls[0]![0];
    expect(q.filters.categoryIds).toEqual(["p", "p1", "p2"]);
    expect(q.categoryId).toBeUndefined();
  });
  it("merges categories from filters with the legacy slug; unknown slugs are dropped, all-unknown yields nothing", async () => {
    await searchListings({ q: "box", categorySlug: "textiles", filters: { categories: ["boxes", "nope"] } });
    expect(searchFn.mock.calls[0]![0].filters.categoryIds).toEqual(["p1", "p2", "t"]);
    expect(await ids({ q: "box", filters: { categories: ["nope"] } })).toEqual([]);
  });
  it("lower-cases places and passes every filter to the index", async () => {
    await searchListings({ q: "box", filters: { minTier: 2, states: ["Gujarat"], cities: ["SURAT"], priceMinPaise: 100, priceMaxPaise: 900, maxMoq: 50, hasPrice: true } });
    expect(searchFn.mock.calls[0]![0].filters).toEqual({ minTier: 2, states: ["gujarat"], cities: ["surat"], priceMinPaise: 100, priceMaxPaise: 900, maxMoq: 50, hasPrice: true });
  });
  it("no filters: no filters key at all", async () => {
    await searchListings({ q: "box" });
    expect(searchFn.mock.calls[0]![0]).not.toHaveProperty("filters");
  });
  it("rejects invalid filters and sort", async () => {
    await expect(searchListings({ q: "box", filters: { minTier: 9 } })).rejects.toThrow();
    await expect(searchListings({ q: "box", sort: "cheapest" as any })).rejects.toThrow();
  });
  it("backstop: a stale index hit that the live seller/listing contradicts is dropped", async () => {
    // index says tier>=2 matches everything, but the live profile of sb is tier 1 and b's MOQ is 500
    expect(await ids({ q: "box", filters: { minTier: 2 } })).toEqual(["c", "a"]);
    expect(await ids({ q: "box", filters: { maxMoq: 100 } })).toEqual(["c", "a"]); // c has no MOQ
    expect(await ids({ q: "box", filters: { hasPrice: true } })).toEqual(["b", "a"]);
  });
  it("facets from the index are passed through", async () => {
    searchFn.mockResolvedValue({ hits: [hit("a", "sa", 1)], nextCursor: null, facets: { category: [], city: [], state: [{ key: "gujarat", count: 3 }], verificationTier: [], price: [] } });
    expect((await searchListings({ q: "box" })).facets?.state[0]).toEqual({ key: "gujarat", count: 3 });
  });
});

describe("searchListings sort", () => {
  it("relevance (default) is relevance x trust: seller b's trust 95 outweighs a one-place lexical lead", async () => {
    expect(await ids({ q: "box" })).toEqual(["b", "c", "a"]);
  });
  it("price low to high / high to low, price on request last", async () => {
    expect(await ids({ q: "box", sort: "price_asc" })).toEqual(["b", "a", "c"]);
    expect(await ids({ q: "box", sort: "price_desc" })).toEqual(["a", "b", "c"]);
  });
  it("newest by first-published", async () => {
    expect(await ids({ q: "box", sort: "newest" })).toEqual(["b", "c", "a"]);
  });
  it("trust: tier first, then trust score", async () => {
    expect(await ids({ q: "box", sort: "trust" })).toEqual(["a", "c", "b"]);
  });
  it("non-relevance sorts widen the candidate pool; the page is still cut to limit", async () => {
    await searchListings({ q: "box", sort: "price_asc", limit: 2 });
    expect(searchFn.mock.calls[0]![0].limit).toBeGreaterThanOrEqual(120);
    expect(await ids({ q: "box", sort: "price_asc", limit: 2 })).toEqual(["b", "a"]);
  });
  it("hits are never sponsored", async () => {
    for (const sort of ["relevance", "price_asc", "price_desc", "newest", "trust"] as const) expect((await searchListings({ q: "box", sort })).hits.every((h) => h.sponsored === false)).toBe(true);
  });
  it("plan / ad-spend fields on the seller profile change no order under any sort", async () => {
    for (const sort of ["relevance", "price_asc", "price_desc", "newest", "trust"] as const) {
      const before = await ids({ q: "box", sort });
      profiles = Object.fromEntries(Object.entries(profiles).map(([k, p], i) => [k, { ...p, plan: i === 0 ? "enterprise" : "free", adSpendPaise: 99_999_999 * (3 - i), sponsoredBoost: 100 }]));
      expect(await ids({ q: "box", sort })).toEqual(before);
    }
  });
});
