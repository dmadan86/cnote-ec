import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
vi.mock("@cnote/core", () => ({
  cachedTagged: async (_k: string, _t: unknown, _ttl: number, load: () => Promise<unknown>) => load(),
  cacheTags: { search: "search", category: (s: string) => s, listing: (i: string) => i, seller: (i: string) => i },
}));
vi.mock("@cnote/ai", () => ({ embed: async () => ({ vectors: [[0.1]], version: "v" }) }));
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => null,
  getPublicListingsByIds: async (ids: string[]) => ids.map((id) => ({ id })),
  retrieveListings: (...a: unknown[]) => retrieve(...a),
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, city: "X", trustScore: 50, badgeActive: false }])) }));

const { searchListings, translitEnabled } = await import("../src/search");
const { setSearchIndexForTests } = await import("../src/index-port/factory");
const { postgresIndex } = await import("../src/index-port/postgres");
const { buildLexicalRequest, VARIANT_BOOST } = await import("../src/index-port/query");

beforeEach(() => {
  retrieve.mockReset();
  retrieve.mockResolvedValue([{ listingId: "a", sellerBusinessId: "s", lexicalRank: 1, similarity: 0.5 }]);
  setSearchIndexForTests(postgresIndex);
});
afterEach(() => {
  delete process.env.SEARCH_TRANSLIT;
  setSearchIndexForTests(undefined);
});

describe("cross-script variants reach the index", () => {
  it("passes lexicon/transliteration variants for a Devanagari query and keeps the embedding on the original text", async () => {
    await searchListings({ q: "मुझे कपास का कपड़ा चाहिए" });
    const arg = retrieve.mock.calls[0]![0];
    expect(arg.text).toBe("कपास कपड़ा");
    expect(arg.variants).toContain("cotton fabric");
    expect(arg.variants).not.toContain("कपास कपड़ा");
    expect(arg.embedding).toEqual([0.1]);
  });
  it("sends no variants key for plain English", async () => {
    await searchListings({ q: "zzqx wxyz" });
    expect(retrieve.mock.calls[0]![0]).not.toHaveProperty("variants");
  });
  it("SEARCH_TRANSLIT=off is a kill switch", async () => {
    process.env.SEARCH_TRANSLIT = "off";
    expect(translitEnabled()).toBe(false);
    await searchListings({ q: "कपास" });
    expect(retrieve.mock.calls[0]![0]).not.toHaveProperty("variants");
    delete process.env.SEARCH_TRANSLIT;
    expect(translitEnabled()).toBe(true);
  });
});

describe("OpenSearch lexical request with variants", () => {
  const base = { text: "कपास", location: null, limit: 10 };
  it("keeps the exact old shape without variants", () => {
    const r: any = buildLexicalRequest(base);
    expect(r.query.bool.must[0]).toHaveProperty("multi_match");
    expect(r.query.bool.should).toHaveLength(1);
  });
  it("ORs the original with down-weighted variants", () => {
    const r: any = buildLexicalRequest({ ...base, variants: ["cotton", "kapas"] });
    const should = r.query.bool.must[0].bool.should;
    expect(should).toHaveLength(3);
    expect(should[0].multi_match.query).toBe("कपास");
    expect(should[0].multi_match.boost).toBeUndefined();
    expect(should[1].multi_match).toMatchObject({ query: "cotton", boost: VARIANT_BOOST });
    expect(r.query.bool.must[0].bool.minimum_should_match).toBe(1);
    expect(r.query.bool.should).toHaveLength(3);
  });
});

describe("postgres adapter", () => {
  it("forwards variants only when present", async () => {
    await postgresIndex.search({ text: "a", location: null, limit: 5, variants: ["b"] });
    expect(retrieve).toHaveBeenLastCalledWith(expect.objectContaining({ variants: ["b"] }));
    await postgresIndex.search({ text: "a", location: null, limit: 5, variants: [] });
    expect(retrieve.mock.calls.at(-1)![0]).not.toHaveProperty("variants");
  });
});
