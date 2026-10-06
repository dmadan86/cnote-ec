// Curated synonyms reach the index on every backend, and the relevance harness ranks like production (ADR-009).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keys: string[] = [];
vi.mock("@cnote/core", () => ({
  cachedTagged: async (key: string, _t: unknown, _ttl: number, load: () => Promise<unknown>) => {
    keys.push(key);
    return load();
  },
  cacheTags: { search: "search", category: (s: string) => s, listing: (i: string) => i, seller: (i: string) => i },
}));
const embedCalls: string[][] = [];
let embedFails = false;
vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => {
    embedCalls.push(texts);
    if (embedFails) throw new Error("embedding outage");
    return { vectors: texts.map(() => [0.1]), version: "v" };
  },
}));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  getPublicListingsByIds: async (ids: string[]) => ids.map((id) => ({ id })),
  listCategories: async () => [],
  retrieveListings: vi.fn(),
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, city: "X", trustScore: 50, badgeActive: false }])) }));
let active: { version: number; groups: { terms: string[] }[] } = { version: 0, groups: [] };
vi.mock("../src/synonyms/store", () => ({ activeSynonymsOrEmpty: async () => active }));

const { searchListings } = await import("../src/search");
const { rankIds } = await import("../src/relevance/rank");
const { setSearchIndexForTests } = await import("../src/index-port/factory");
const { buildLexicalRequest } = await import("../src/index-port/query");

const searchFn = vi.fn();
const hits = [
  { listingId: "a", sellerBusinessId: "s1", lexicalScore: 0.2, vectorScore: 0.9 },
  { listingId: "b", sellerBusinessId: "s2", lexicalScore: 0.9, vectorScore: 0.3 },
  { listingId: "c", sellerBusinessId: "s3", lexicalScore: 0.5, vectorScore: 0.6 },
];
const fake = { backend: "opensearch", search: searchFn, upsert: vi.fn(), remove: vi.fn(), health: vi.fn(), reindexAll: vi.fn() } as never;

beforeEach(() => {
  keys.length = 0;
  embedCalls.length = 0;
  embedFails = false;
  searchFn.mockReset();
  searchFn.mockResolvedValue({ hits, nextCursor: null });
  active = { version: 0, groups: [] };
  setSearchIndexForTests(fake);
});
afterEach(() => {
  delete process.env.SEARCH_SYNONYMS;
  setSearchIndexForTests(undefined);
});

describe("curated synonyms in searchListings", () => {
  it("adds curated variants ahead of the built-in ones, for Latin and Indic queries alike", async () => {
    active = { version: 3, groups: [{ terms: ["dhaaga", "yarn", "सूत"] }] };
    await searchListings({ q: "dhaaga" });
    expect(searchFn.mock.calls[0]![0].variants).toEqual(expect.arrayContaining(["yarn", "सूत"]));
    expect(searchFn.mock.calls[0]![0].variants[0]).toBe("yarn");
    searchFn.mockClear();
    await searchListings({ q: "सूत" });
    const v: string[] = searchFn.mock.calls[0]![0].variants;
    expect(v.slice(0, 2)).toEqual(["dhaaga", "yarn"]);
  });

  it("the Latin curated variant drives the embedding of an Indic query (planSemantic)", async () => {
    active = { version: 3, groups: [{ terms: ["सूत", "dhaaga", "yarn"] }] };
    await searchListings({ q: "सूत" });
    expect(embedCalls.at(-1)).toEqual(["dhaaga"]);
  });

  it("the dictionary version is part of the cache key, so a publish changes every key at once", async () => {
    await searchListings({ q: "dhaaga" });
    active = { version: 4, groups: [{ terms: ["dhaaga", "yarn"] }] };
    await searchListings({ q: "dhaaga" });
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toMatch(/^search:q:v6:[0-9a-f]{40}$/);
  });

  it("SEARCH_SYNONYMS=off ignores the dictionary (kill switch)", async () => {
    active = { version: 3, groups: [{ terms: ["dhaaga", "yarn"] }] };
    process.env.SEARCH_SYNONYMS = "off";
    await searchListings({ q: "dhaaga" });
    expect(searchFn.mock.calls[0]![0].variants ?? []).not.toContain("yarn");
  });

  it("OpenSearch gets the same variants as a query-side OR (parity with Postgres FTS, which receives them verbatim)", async () => {
    active = { version: 3, groups: [{ terms: ["dhaaga", "yarn"] }] };
    await searchListings({ q: "dhaaga" });
    const q = searchFn.mock.calls[0]![0];
    const should = (buildLexicalRequest(q) as { query: { bool: { must: { bool: { should: { multi_match: { query: string } }[] } }[] } } }).query.bool.must[0]!.bool.should;
    expect(should.map((s) => s.multi_match.query)).toEqual(expect.arrayContaining(["dhaaga", "yarn"]));
  });
});

describe("the relevance harness ranks like production", () => {
  it("produces the same order as searchListings when every seller has the same trust", async () => {
    active = { version: 3, groups: [{ terms: ["dhaaga", "yarn"] }] };
    const prod = (await searchListings({ q: "dhaaga" })).hits.map((h) => h.listing.id);
    const ids = await rankIds(fake, "dhaaga", { synonyms: active.groups });
    expect(ids).toEqual(prod);
    expect(searchFn.mock.calls[1]![0]).toMatchObject({ text: "dhaaga", variants: searchFn.mock.calls[0]![0].variants });
  });

  it("honours translit off, filters, limit, and an embedding outage", async () => {
    const ids = await rankIds(fake, "कपास", { translit: false, filters: { categoryIds: ["c1"] }, limit: 2 });
    expect(ids).toHaveLength(2);
    expect(searchFn.mock.calls[0]![0]).toMatchObject({ filters: { categoryIds: ["c1"] } });
    expect(searchFn.mock.calls[0]![0]).not.toHaveProperty("variants");
    expect(await rankIds(fake, "   ")).toEqual([]);
    embedFails = true;
    await rankIds(fake, "yarn");
    expect(searchFn.mock.calls.at(-1)![0].embedding).toBeUndefined(); // lexical-only, like production
  });
});
