import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveDb, toVectorLiteral } from "@cnote/live-db";
import { retrieveFacetRows, retrieveListings } from "../src/retrieval";

// Live rows are written straight into the LIVE read database: this exercises the SQL filters, not the publisher.
const tag = `flt${randomUUID().slice(0, 8)}`;
const catA = randomUUID();
const catB = randomUUID();
const ids: Record<string, string> = {};
const now = new Date();

async function seed(key: string, o: { cat: string; slug: string; price: number | null; moq: number | null; tier: number; state: string | null; city: string | null; embedding?: number[] }) {
  const id = randomUUID();
  ids[key] = id;
  await liveDb.liveListing.create({
    data: {
      id, versionId: randomUUID(), version: 1, sellerBusinessId: randomUUID(), categoryId: o.cat, categorySlug: o.slug, categoryName: o.slug,
      title: `Steel ${tag} ${key}`, description: "", pricePaise: o.price === null ? null : BigInt(o.price), moq: o.moq,
      sellerName: `S ${key}`, sellerCity: o.city, sellerState: o.state, sellerTier: o.tier, sellerTrustScore: 50,
      firstPublishedAt: now, publishedAt: now,
    },
  });
  if (o.embedding) await liveDb.$executeRaw`UPDATE live_listings SET embedding = ${toVectorLiteral(o.embedding)}::vector WHERE id = ${id}::uuid`;
}

const text = `steel ${tag}`;
const ask = async (filters: Parameters<typeof retrieveListings>[0]["filters"]) => {
  const r = await retrieveListings({ text, filters, limit: 50 });
  return r.map((x) => Object.keys(ids).find((k) => ids[k] === x.listingId)!).sort();
};

beforeAll(async () => {
  await seed("a", { cat: catA, slug: `a-${tag}`, price: 50_000, moq: 10, tier: 3, state: "Gujarat", city: "Surat" });
  await seed("b", { cat: catA, slug: `a-${tag}`, price: 500_000, moq: 500, tier: 1, state: "gujarat", city: "Rajkot" });
  await seed("c", { cat: catB, slug: `b-${tag}`, price: null, moq: null, tier: 2, state: "Delhi", city: "Delhi" });
  await seed("d", { cat: catB, slug: `b-${tag}`, price: 20_000_000, moq: 1, tier: 0, state: null, city: null });
});
afterAll(async () => {
  await liveDb.liveListing.deleteMany({ where: { id: { in: Object.values(ids) } } });
});

describe("retrieveListings filters (live SQL)", () => {
  it("no filters returns everything that matches the text", async () => expect(await ask(undefined)).toEqual(["a", "b", "c", "d"]));
  it("minimum tier is inclusive", async () => expect(await ask({ minTier: 2 })).toEqual(["a", "c"]));
  it("state and city match case-insensitively; a state filter excludes unknown-state sellers", async () => {
    expect(await ask({ states: ["GUJARAT"] })).toEqual(["a", "b"]);
    expect(await ask({ cities: ["surat", "delhi"] })).toEqual(["a", "c"]);
  });
  it("price range excludes price-on-request; hasPrice alone excludes only price-on-request", async () => {
    expect(await ask({ priceMinPaise: 100_000, priceMaxPaise: 1_000_000 })).toEqual(["b"]);
    expect(await ask({ hasPrice: true })).toEqual(["a", "b", "d"]);
  });
  it("max MOQ keeps listings with no stated MOQ", async () => expect(await ask({ maxMoq: 10 })).toEqual(["a", "c", "d"]));
  it("category ids (parent + subcategory ids) and combined filters AND together", async () => {
    expect(await ask({ categoryIds: [catB] })).toEqual(["c", "d"]);
    expect(await ask({ categoryIds: [catA, catB], minTier: 1, hasPrice: true })).toEqual(["a", "b"]);
    expect(await ask({ categoryIds: ["not-a-uuid"] })).toEqual([]);
  });
  it("filters also apply to the vector leg", async () => {
    const e = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));
    await liveDb.$executeRaw`UPDATE live_listings SET embedding = ${toVectorLiteral(e)}::vector WHERE id IN (${ids.a}::uuid, ${ids.c}::uuid)`;
    const r = await retrieveListings({ embedding: e, filters: { minTier: 3 }, limit: 50 });
    expect(r.map((x) => x.listingId)).toContain(ids.a);
    expect(r.map((x) => x.listingId)).not.toContain(ids.c);
  });
});

describe("retrieveFacetRows", () => {
  it("returns unfiltered rows for the lexical match with the facet columns", async () => {
    const rows = await retrieveFacetRows({ text });
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.categoryId === catA && r.tier === 3)).toMatchObject({ state: "Gujarat", city: "Surat", pricePaise: 50_000, moq: 10 });
    expect(rows.filter((r) => r.pricePaise === null)).toHaveLength(1);
  });
  it("a text with no usable token yields nothing; a different text does not leak rows", async () => {
    expect(await retrieveFacetRows({ text: "?" })).toEqual([]);
    expect(await retrieveFacetRows({ text: `nomatch${tag}x` })).toEqual([]);
  });
});
