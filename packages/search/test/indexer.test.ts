import { beforeEach, describe, expect, it, vi } from "vitest";

const listings = new Map<string, any>();
vi.mock("@cnote/ai", () => ({ embed: async (t: string[]) => ({ vectors: t.map(() => [0.1]), version: "v" }) }));
vi.mock("@cnote/catalogue", () => ({
  getPublicListingsByIds: async (ids: string[]) => ids.flatMap((i) => listings.get(i) ?? []),
  listPublicSellerListings: async (b: string) => [...listings.values()].filter((l) => l.sellerBusinessId === b),
  countPublicListings: async () => listings.size,
  listPublicListingIndex: async ({ offset, limit }: any) => [...listings.values()].slice(offset, offset + limit).map((l) => ({ id: l.id })),
  retrieveListings: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => i !== "ghost").map((i) => [i, { businessId: i, city: "Surat", state: "GJ", verificationTier: 2, trustScore: 70, badgeActive: false, name: "n", pincode: null, languages: [] }])),
}));

const { syncListings, indexerHandlers, streamAllDocs, buildDocs } = await import("../src/indexer");
const { setSearchIndexForTests } = await import("../src/index-port/factory");

const view = (id: string, seller = "s1") => ({
  id, sellerBusinessId: seller, category: { id: "c", slug: "pk", name: "Pk" }, title: "T " + id, description: "D", pricePaise: 100, moq: 5, updatedAt: "2026-01-01T00:00:00Z",
});
const fakeIndex = (backend: "postgres" | "opensearch") => ({
  backend, search: vi.fn(), upsert: vi.fn(async () => {}), remove: vi.fn(async () => {}), health: vi.fn(), reindexAll: vi.fn(),
});
const ev = (type: string, payload: object) => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: "" }) as any;

beforeEach(() => {
  listings.clear();
  setSearchIndexForTests(undefined);
});

describe("searchIndexer", () => {
  it("is a no-op on the postgres backend", async () => {
    const idx = fakeIndex("postgres");
    setSearchIndexForTests(idx as any);
    listings.set("a", view("a"));
    await indexerHandlers.ListingVersionPublished!(ev("ListingVersionPublished", { listingId: "a" }));
    await indexerHandlers.ListingArchived!(ev("ListingArchived", { listingId: "a" }));
    expect(idx.upsert).not.toHaveBeenCalled();
    expect(idx.remove).not.toHaveBeenCalled();
  });

  it("upserts live listings with embeddings and trust, removes non-live ones; replay is identical", async () => {
    const idx = fakeIndex("opensearch");
    setSearchIndexForTests(idx as any);
    listings.set("a", view("a"));
    const e = ev("ListingVersionPublished", { listingId: "a" });
    await indexerHandlers.ListingVersionPublished!(e);
    await indexerHandlers.ListingVersionPublished!(e);
    const [first, second] = idx.upsert.mock.calls as any[];
    expect(first[0][0]).toMatchObject({ listingId: "a", city: "Surat", trustScore: 70, embedding: [0.1] });
    expect({ ...first[0][0], version: 0 }).toEqual({ ...second[0][0], version: 0 }); // same doc => idempotent
    expect(idx.remove).toHaveBeenLastCalledWith([]);
    await syncListings(["gone"], idx as any);
    expect(idx.remove).toHaveBeenLastCalledWith(["gone"]);
  });

  it("takedown events remove directly; rejected moderation removes; approved re-syncs", async () => {
    const idx = fakeIndex("opensearch");
    setSearchIndexForTests(idx as any);
    listings.set("a", view("a"));
    await indexerHandlers.ListingUnpublished!(ev("ListingUnpublished", { listingId: "a" }));
    await indexerHandlers.ListingModerated!(ev("ListingModerated", { listingId: "a", status: "rejected" }));
    expect(idx.remove).toHaveBeenCalledTimes(2);
    expect(idx.upsert).not.toHaveBeenCalled();
    await indexerHandlers.ListingModerated!(ev("ListingModerated", { listingId: "a", status: "approved" }));
    expect(idx.upsert).toHaveBeenCalledTimes(1);
  });

  it("trust/verification events reindex every live listing of the seller", async () => {
    const idx = fakeIndex("opensearch");
    setSearchIndexForTests(idx as any);
    listings.set("a", view("a", "s1"));
    listings.set("b", view("b", "s1"));
    listings.set("c", view("c", "s2"));
    await indexerHandlers.TrustScoreChanged!(ev("TrustScoreChanged", { businessId: "s1" }));
    expect((idx.upsert.mock.calls[0] as any)[0].map((d: any) => d.listingId)).toEqual(["a", "b"]);
  });

  it("skips listings whose seller has no profile, and streams all docs in batches", async () => {
    listings.set("a", view("a"));
    listings.set("g", view("g", "ghost"));
    expect((await buildDocs([...listings.values()])).map((d) => d.listingId)).toEqual(["a"]);
    listings.set("b", view("b"));
    const batches: string[][] = [];
    for await (const b of streamAllDocs(2)) batches.push(b.map((d) => d.listingId));
    expect(batches).toEqual([["a"], ["b"]]);
  });
});
