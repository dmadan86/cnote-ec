// ADR-024 rule 1 / design principle P1: organic order is identical with ads on and off, for random queries and fixtures.
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// no caching in the way: every call recomputes organic ranking, so equality is a real property of the code, not of a cache
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), cachedTagged: async (_k: string, _t: unknown, _ttl: number, load: () => Promise<unknown>) => load() }));
vi.mock("@cnote/ai", () => ({ embed: async (t: string[]) => ({ vectors: t.map(() => [0.1]), version: "v" }) }));

const N = 40;
const listing = (i: number) => ({
  id: `l-${i}`, sellerBusinessId: `s-${i % 7}`, category: { id: "cat", slug: "cat", name: "Cat" }, title: `Cosmetic box ${i} premium`, description: "", attributes: {}, pricePaise: 1000 + i, priceUnit: "piece", moq: 10, moqUnit: "piece",
  hsn: null, language: "en", imageUrls: ["/i"], aiGenerated: false, status: "published", moderationStatus: "approved", moderationReason: null, createdAt: "", updatedAt: "",
});
vi.mock("@cnote/catalogue", () => ({
  getCategoryBySlug: async () => ({ id: "cat", slug: "cat", name: "Cat" }),
  getPublicListingsByIds: async (ids: string[]) => ids.filter((i) => /^l-\d+$/.test(i)).map((i) => listing(Number(i.slice(2)))),
  listCategories: async () => [],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { businessId: id, name: id, city: Number(id.slice(2)) % 2 ? "Surat" : "Delhi", state: null, pincode: null, verificationTier: 1, trustScore: 40 + Number(id.slice(2)) * 8, badgeActive: Number(id.slice(2)) % 3 === 0, languages: ["en"] }])),
  isBusinessMember: async () => false,
}));

// the snapshot the ad decision reads: advertisers for many listings, some of which also rank organically
const candidates = Array.from({ length: N }, (_, i) => ({
  id: `ag-${i}`, campaignId: `camp-${i}`, adGroupId: `g-${i}`, listingId: `l-${i}`, sellerBusinessId: `s-${i % 7}`, categoryId: "cat", listingChain: ["cat"], title: `Cosmetic box ${i} premium`,
  surfaces: ["search", "category"], cpc: { search: 500 + i * 1000, category: 400 }, keywords: [{ n: "cosmetic box", m: "phrase" as const }], negatives: [], targetCategories: [], states: [], pincodePrefixes: [],
  dailyBudgetPaise: 1_000_000, totalBudgetPaise: null, startsAt: 0, endsAt: null, trustScore: 60 + (i % 40), badgeActive: i % 2 === 0, verificationTier: 1, sellerState: null,
}));
vi.mock("../src/eligibility", async () => {
  const { adsConfigSchema } = await import("../src/config");
  return {
    loadSnapshot: async () => ({ v: 1, builtAt: Date.now(), config: adsConfigSchema.parse({}), categoryParent: { cat: null }, candidates }),
    runEligibilitySweep: async () => null,
    invalidateSnapshot: async () => undefined,
  };
});

const { searchListings } = await import("@cnote/search");
const { setSearchIndexForTests } = await import("../../search/src/index-port/factory");
const { getSponsoredSlots } = await import("../src/decision");

// deterministic pseudo index: scores derived from the query text so different queries reorder results
function fakeIndex(seed: number) {
  const h = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, seed);
  return {
    backend: "postgres",
    search: async (q: { text: string }) => ({
      hits: Array.from({ length: N }, (_, i) => ({ listingId: `l-${i}`, sellerBusinessId: `s-${i % 7}`, lexicalScore: (h(q.text + i) % 100) / 10, vectorScore: ((h(i + q.text) % 100) / 100) * 0.9 })),
      nextCursor: null,
    }),
    upsert: async () => undefined, remove: async () => undefined, health: async () => ({}), reindexAll: async () => ({}),
  } as never;
}

const words = ["cosmetic", "box", "premium", "packaging", "bag", "tube", "in", "surat", "delhi", "bulk", "ke", "liye", "chahiye"];
const queryArb = fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 5 }).map((w) => w.join(" "));
const strip = (r: Awaited<ReturnType<typeof searchListings>>) => r.hits.map((h) => ({ id: h.listing.id, score: h.score, sponsored: h.sponsored, seller: h.seller.businessId }));

beforeAll(() => {
  process.env.ADS_TOKEN_SECRET = "t";
});
afterAll(() => {
  delete process.env.ADS_ENABLED;
});

describe("organic integrity (ADR-024 rule 1)", () => {
  it("searchListings order is identical with ads enabled vs disabled, for random queries and fixtures", async () => {
    let adsServed = 0;
    await fc.assert(
      fc.asyncProperty(queryArb, fc.integer({ min: 10, max: 30 }), fc.integer({ min: 1, max: 1000 }), async (q, limit, seed) => {
        setSearchIndexForTests(fakeIndex(seed));

        process.env.ADS_ENABLED = "false";
        const off = await searchListings({ q, limit });
        expect(await getSponsoredSlots({ query: q, surface: "search", organicListingIds: off.hits.map((h) => h.listing.id), random: () => 0 })).toEqual([]);

        process.env.ADS_ENABLED = "true";
        const organicIds = off.hits.map((h) => h.listing.id);
        const slots = await getSponsoredSlots({ query: q, surface: "search", organicListingIds: organicIds, visitorId: `v${seed}`, random: () => 0 });
        adsServed += slots.length;
        const on = await searchListings({ q, limit });

        expect(strip(on)).toEqual(strip(off)); // same ids, same order, same scores
        expect(on.hits.every((h) => h.sponsored === false)).toBe(true); // organic hits never carry the sponsored flag
        for (const s of slots) {
          expect(organicIds).not.toContain(s.listing.id); // an ad never duplicates an organic result
          expect(s.sponsored).toBe(true);
          expect(s.label).toBe("Sponsored");
        }
        expect(slots.length).toBeLessThanOrEqual(2);
      }),
      { numRuns: 60 },
    );
    expect(adsServed).toBeGreaterThan(0); // the property was exercised with ads actually being served
  });

  it("a higher price never changes which ad wins: only quality does (rate card is not a ranking input)", async () => {
    process.env.ADS_ENABLED = "true";
    setSearchIndexForTests(fakeIndex(7));
    const organicIds = ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "o9", "o10"];
    // A fresh visitor per run: serving records a per-(visitor, listing) frequency counter in Redis (cap 5 per window), so a fixed id
    // would hit its cap after a few runs against the same Redis and the "winner" would legitimately move to the next ad.
    const visitorId = `x-${globalThis.crypto.randomUUID()}`;
    const a = await getSponsoredSlots({ query: "cosmetic box", surface: "search", organicListingIds: organicIds, visitorId, random: () => 0, now: new Date("2026-09-30T05:00:00Z") });
    // reshuffle every advertiser's price (the snapshot is read live): winner selection must not move
    const original = candidates.map((c) => c.cpc.search);
    candidates.forEach((c, i) => (c.cpc.search = 300 + ((i * 7919) % 50) * 1000));
    const b = await getSponsoredSlots({ query: "cosmetic box", surface: "search", organicListingIds: organicIds, visitorId, random: () => 0, now: new Date("2026-09-30T05:00:00Z") });
    candidates.forEach((c, i) => (c.cpc.search = original[i]!));
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((s) => s.listing.id)).toEqual(a.map((s) => s.listing.id));
    expect(b.map((s) => s.cpcPaise)).not.toEqual(a.map((s) => s.cpcPaise)); // price did change, order did not
  });

  it("organic ranking source never imports ads (the dependency only goes ads -> search)", () => {
    const dir = path.resolve(import.meta.dirname, "../../search/src");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : f.endsWith(".ts") && files.push(path.join(d, f))));
    walk(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/@cnote\/ads|from ["']\.\.\/\.\.\/ads/);
  });
});
