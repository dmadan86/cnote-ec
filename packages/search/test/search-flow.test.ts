import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { key: string; tags: (v: any) => string[]; ttl: number }[] = [];
const store = new Map<string, unknown>();
vi.mock("@cnote/core", () => ({
  cachedTagged: async (key: string, tags: any, ttl: number, load: () => Promise<unknown>) => {
    calls.push({ key, tags, ttl });
    if (store.has(key)) return store.get(key);
    const v = await load(); store.set(key, v); return v;
  },
  cacheTags: { search: "search", categories: "categories", category: (s: string) => `category:${s}`, listing: (i: string) => `listing:${i}`, seller: (i: string) => `seller:${i}` },
}));
let embedImpl: () => Promise<any> = async () => ({ vectors: [[0.1]], version: "v" });
vi.mock("@cnote/ai", () => ({ embed: () => embedImpl() }));
const cats = new Map<string, any>([["packaging", { id: "c1", slug: "packaging", name: "Packaging" }]]);
let categories: any[] = [];
let titles: string[] = [];
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async (s: string) => cats.get(s) ?? null,
  getPublicListingsByIds: async (ids: string[]) => ids.filter((i) => i !== "unpublished").map((id) => ({ id })),
  listCategories: async () => categories,
  suggestListingTitles: async () => titles,
  retrieveListings: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => i !== "ghost").map((i) => [i, { businessId: i, city: i === "s-city" ? "Surat" : "X", trustScore: i === "s-hi" ? 90 : 30, badgeActive: false }])),
}));

const { searchListings } = await import("../src/search");
const { suggest, EXAMPLE_QUERIES } = await import("../src/suggest");
const { setSearchIndexForTests } = await import("../src/index-port/factory");

const searchFn = vi.fn();
const fake = (over: object = {}) => ({ backend: "opensearch", search: searchFn, upsert: vi.fn(), remove: vi.fn(), health: vi.fn(), reindexAll: vi.fn(), ...over }) as any;
const hit = (id: string, seller = "s-hi", lex = 1, vec = 0.5) => ({ listingId: id, sellerBusinessId: seller, lexicalScore: lex, vectorScore: vec });

beforeEach(() => {
  calls.length = 0; store.clear(); searchFn.mockReset(); embedImpl = async () => ({ vectors: [[0.1]], version: "v" });
  categories = []; titles = [];
  setSearchIndexForTests(fake());
});

describe("searchListings", () => {
  it("validates options", async () => {
    await expect(searchListings({ q: "x".repeat(501) })).rejects.toThrow();
    await expect(searchListings({ q: "a", limit: 0 })).rejects.toThrow();
    await expect(searchListings({ q: "a", limit: 51 })).rejects.toThrow();
    await expect(searchListings({ q: "a", limit: 1.5 })).rejects.toThrow();
  });
  it("empty text without category returns nothing and never queries the index", async () => {
    const r = await searchListings({ q: "   " });
    expect(r.hits).toEqual([]);
    expect(searchFn).not.toHaveBeenCalled();
  });
  it("unknown category yields empty; known category browse falls back to category name", async () => {
    expect((await searchListings({ q: "boxes", categorySlug: "nope" })).hits).toEqual([]);
    searchFn.mockResolvedValue({ hits: [hit("a")], nextCursor: null });
    await searchListings({ q: "", categorySlug: "packaging" });
    expect(searchFn.mock.calls[0]![0]).toMatchObject({ text: "Packaging", categoryId: "c1" });
  });
  it("embedding outage degrades to lexical-only", async () => {
    embedImpl = async () => { throw new Error("down"); };
    searchFn.mockResolvedValue({ hits: [hit("a", "s-hi", 1, 0)], nextCursor: null });
    const r = await searchListings({ q: "boxes" });
    expect(searchFn.mock.calls[0]![0].embedding).toBeUndefined();
    expect(r.hits).toHaveLength(1);
  });
  it("no candidates: empty hits but facets preserved", async () => {
    searchFn.mockResolvedValue({ hits: [], nextCursor: null, facets: { category: [{ key: "k", count: 1 }], city: [], verificationTier: [], price: [] } });
    const r = await searchListings({ q: "zzz" });
    expect(r.hits).toEqual([]);
    expect(r.facets?.category[0]!.key).toBe("k");
  });
  it("drops listings that are no longer public in LIVE, and unknown sellers", async () => {
    searchFn.mockResolvedValue({ hits: [hit("unpublished"), hit("ghostly", "ghost"), hit("ok")], nextCursor: null });
    expect((await searchListings({ q: "x" })).hits.map((h) => h.listing.id)).toEqual(["ok"]);
  });
  it("hits beyond vector-noise-only and lexical zero are excluded (relevance 0)", async () => {
    searchFn.mockResolvedValue({ hits: [hit("noise", "s-hi", 0, 0.01), hit("ok")], nextCursor: null });
    expect((await searchListings({ q: "x" })).hits.map((h) => h.listing.id)).toEqual(["ok"]);
  });
  it("respects limit and passes an over-fetch window", async () => {
    searchFn.mockResolvedValue({ hits: Array.from({ length: 10 }, (_, i) => hit(`l${i}`, "s-hi", 10 - i, 0.9 - i / 100)), nextCursor: null });
    const r = await searchListings({ q: "x", limit: 3 });
    expect(r.hits).toHaveLength(3);
    expect(searchFn.mock.calls[0]![0].limit).toBe(30);
    searchFn.mockClear(); store.clear();
    await searchListings({ q: "x", limit: 20 });
    expect(searchFn.mock.calls[0]![0].limit).toBe(60);
  });
  it("output is sorted by score desc and stable across repeated identical inputs", async () => {
    const hits = [hit("a", "s-lo", 1, 0.4), hit("b", "s-hi", 2, 0.5), hit("c", "s-hi", 0.5, 0.9), hit("d", "s-lo", 3, 0.3)];
    searchFn.mockResolvedValue({ hits, nextCursor: null });
    const r1 = await searchListings({ q: "x" });
    store.clear();
    const r2 = await searchListings({ q: "x" });
    expect(r1.hits.map((h) => h.listing.id)).toEqual(r2.hits.map((h) => h.listing.id));
    const scores = r1.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
  it("cursor pagination: nextCursor forwarded, cursor passed to the index and part of the cache key", async () => {
    searchFn.mockResolvedValueOnce({ hits: [hit("a")], nextCursor: "CUR1" }).mockResolvedValueOnce({ hits: [hit("b")], nextCursor: null });
    const p1 = await searchListings({ q: "x" });
    expect(p1.nextCursor).toBe("CUR1");
    const p2 = await searchListings({ q: "x", cursor: p1.nextCursor! });
    expect(searchFn.mock.calls[1]![0].cursor).toBe("CUR1");
    expect(p2).not.toHaveProperty("nextCursor");
    expect(calls[0]!.key).not.toBe(calls[1]!.key);
  });
  it("cache keys are normalised: equivalent phrasings share a key; different backend/category/limit do not", async () => {
    searchFn.mockResolvedValue({ hits: [hit("a")], nextCursor: null });
    await searchListings({ q: "Boxes   CHAHIYE" });
    await searchListings({ q: "boxes" });
    expect(calls[0]!.key).toBe(calls[1]!.key);
    expect(searchFn).toHaveBeenCalledTimes(1);
    await searchListings({ q: "boxes", limit: 5 });
    await searchListings({ q: "boxes", categorySlug: "packaging" });
    setSearchIndexForTests(fake({ backend: "postgres" }));
    await searchListings({ q: "boxes" });
    expect(new Set(calls.map((c) => c.key)).size).toBe(4);
    expect(calls[0]!.key).toMatch(/^search:q:v4:[0-9a-f]{40}$/);
  });
  it("cache tags include search, category, and every listing+seller shown", async () => {
    searchFn.mockResolvedValue({ hits: [hit("a", "s-hi")], nextCursor: null });
    const r = await searchListings({ q: "x", categorySlug: "packaging" });
    const tags = calls[0]!.tags({ hits: r.hits });
    expect(tags).toEqual(expect.arrayContaining(["search", "category:packaging", "listing:a", "seller:s-hi"]));
    expect(calls[0]!.tags({ hits: [] })).toEqual(["search", "category:packaging"]);
  });
  it("score never depends on payment-ish fields on profile", async () => {
    searchFn.mockResolvedValue({ hits: [hit("a", "s-lo"), hit("b", "s-hi")], nextCursor: null });
    const r = await searchListings({ q: "x" });
    expect(r.hits.every((h) => h.sponsored === false)).toBe(true);
    expect(r.hits[0]!.seller.trustScore).toBeGreaterThan(r.hits[1]!.seller.trustScore);
  });
});

describe("suggest", () => {
  it("clamps limit, normalises prefix for cache key", async () => {
    expect(await suggest("", 0)).toHaveLength(1);
    expect(await suggest("", 99)).toEqual(EXAMPLE_QUERIES);
    await suggest("  PACK   x ", 5);
    expect(calls.at(-1)!.key).toBe("search:suggest:v2:5:pack x");
  });
  it("merges examples, non-prohibited categories, titles; dedups case-insensitively; caps at limit", async () => {
    categories = [{ name: "Packaging Tape", prohibited: false }, { name: "Packaged Poison", prohibited: true }];
    titles = ["packaging tape", "Packing peanuts", "Packing foam"];
    const r = await suggest("pack", 4);
    expect(r).toEqual(["Packaging boxes for cosmetics", "Packaging Tape", "Packing peanuts", "Packing foam"]);
    expect(r).not.toContain("Packaged Poison");
  });
  it("matches on any word prefix", async () => {
    expect(await suggest("cosm")).toContain("Packaging boxes for cosmetics");
    expect(await suggest("zzzq")).toEqual([]);
  });
});
