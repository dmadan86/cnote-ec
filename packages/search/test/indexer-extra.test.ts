import { beforeEach, describe, expect, it, vi } from "vitest";

const listings = new Map<string, any>();
let embed: (t: string[]) => Promise<any> = async (t) => ({ vectors: t.map(() => [0.1]), version: "v" });
vi.mock("@cnote/ai", () => ({ embed: (t: string[]) => embed(t) }));
vi.mock("@cnote/catalogue", () => ({
  getPublicListingsByIds: async (ids: string[]) => ids.flatMap((i) => listings.get(i) ?? []),
  listPublicSellerListings: async (b: string) => [...listings.values()].filter((l) => l.sellerBusinessId === b),
  countPublicListings: async () => listings.size,
  listPublicListingIndex: async ({ offset, limit }: any) => [...listings.values()].slice(offset, offset + limit).map((l) => ({ id: l.id })),
  retrieveListings: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, city: null, state: null, verificationTier: 1, trustScore: 50, badgeActive: true }])),
}));
const { buildDocs, indexerHandlers, reindexAll, searchIndexer, syncListings } = await import("../src/indexer");
const { setSearchIndexForTests } = await import("../src/index-port/factory");

const view = (id: string, seller = "s1") => ({ id, sellerBusinessId: seller, category: { id: "c", slug: "p", name: "P" }, title: "T", description: "D".repeat(5000), pricePaise: null, moq: null, updatedAt: "x" });
const idx = (backend = "opensearch") => ({ backend, search: vi.fn(), upsert: vi.fn(async () => {}), remove: vi.fn(async () => {}), health: vi.fn(), reindexAll: vi.fn(async (s: any) => { for await (const _ of s) void _; return { indexed: 1, failed: 0, index: "x" }; }) }) as any;
const ev = (p: object) => ({ payload: p }) as any;

beforeEach(() => { listings.clear(); embed = async (t) => ({ vectors: t.map(() => [0.1]), version: "v" }); setSearchIndexForTests(undefined); });

describe("indexer extra", () => {
  it("empty input; embedding outage indexes without vectors; text truncated to 2000; batches by 32", async () => {
    expect(await buildDocs([])).toEqual([]);
    const seen: string[][] = [];
    embed = async (t) => { seen.push(t); return { vectors: t.map(() => [1]), version: "v" }; };
    const many = Array.from({ length: 70 }, (_, i) => view(`l${i}`));
    const docs = await buildDocs(many as any, 123);
    expect(seen.map((s) => s.length)).toEqual([32, 32, 6]);
    expect(seen[0]![0]!.length).toBe(2000);
    expect(docs.every((d) => d.version === 123 && d.embedding)).toBe(true);
    embed = async () => { throw new Error("outage"); };
    expect((await buildDocs([view("a")] as any))[0]!.embedding).toBeUndefined();
  });
  it("version is monotone across calls so older writes lose", async () => {
    const a = (await buildDocs([view("a")] as any, 1))[0]!;
    const b = (await buildDocs([view("a")] as any, 2))[0]!;
    expect(b.version!).toBeGreaterThan(a.version!);
  });
  it("syncListings dedups ids, no-ops on empty; removes non-live ids", async () => {
    const i = idx(); listings.set("a", view("a"));
    await syncListings([], i);
    expect(i.upsert).not.toHaveBeenCalled();
    await syncListings(["a", "a", "b"], i);
    expect(i.upsert.mock.calls[0][0]).toHaveLength(1);
    expect(i.remove).toHaveBeenCalledWith(["b"]);
  });
  it("events: image moderated / published / archived / business verified", async () => {
    const i = idx(); setSearchIndexForTests(i); listings.set("a", view("a"));
    await indexerHandlers.ListingImageModerated!(ev({ listingId: "a" }));
    await indexerHandlers.ListingArchived!(ev({ listingId: "a" }));
    await indexerHandlers.BusinessVerified!(ev({ businessId: "s1" }));
    expect(i.upsert).toHaveBeenCalledTimes(2);
    expect(i.remove).toHaveBeenCalledWith(["a"]);
  });
  it("syncSeller chunks by 200", async () => {
    const i = idx(); setSearchIndexForTests(i);
    for (let n = 0; n < 250; n++) listings.set(`l${n}`, view(`l${n}`));
    await indexerHandlers.TrustScoreChanged!(ev({ businessId: "s1" }));
    expect(i.upsert.mock.calls.map((c: any) => c[0].length)).toEqual([200, 50]);
  });
  it("postgres backend: seller events are no-ops; reindexAll drains stream", async () => {
    const p = idx("postgres"); setSearchIndexForTests(p);
    await indexerHandlers.TrustScoreChanged!(ev({ businessId: "s1" }));
    expect(p.upsert).not.toHaveBeenCalled();
    listings.set("a", view("a"));
    expect(await reindexAll(idx())).toEqual({ indexed: 1, failed: 0, index: "x" });
    expect(searchIndexer.name).toBe("search-indexer");
  });
});
