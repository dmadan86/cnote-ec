import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM, prisma } from "@cnote/db";
import { liveDb } from "@cnote/live-db";

const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0));
vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => vec), version: "test-v1" }),
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 0.9, needsReview: false, deterministic: "clean" }),
}));
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret";
process.env.LISTING_AUTO_APPROVE_MIN_HUMAN_APPROVED = "0";
process.env.LISTING_AUTO_APPROVE_SAMPLE_RATE = "0";
const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
const DAY = 86_400_000;
let seller = "";
let catId = "";
const listingIds: string[] = [];

beforeAll(async () => {
  const [c] = await cat.upsertCategories([{ slug: `t-ph-${tag}`, name: "Test PH", attributeSchema: { fields: [] } }]);
  catId = c!.id;
  seller = (await prisma.business.create({ data: { name: `PH ${tag}`, isSeller: true, verificationTier: 2, trustScore: 80, createdAt: new Date(Date.now() - 90 * 86_400_000) } })).id;
});
afterAll(async () => {
  await prisma.listingPriceHistory.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: listingIds } } }).catch(() => {});
  await liveDb.liveListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.listing.updateMany({ where: { id: { in: listingIds } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.business.deleteMany({ where: { id: seller } });
  // tolerate a foreign draft: draftListingFromText/Photos fall back to the first category in the DB, so a parallel file may still reference this one
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } }).catch(() => {});
});

const mkListing = async () => {
  const l = await prisma.listing.create({ data: { sellerBusinessId: seller, categoryId: catId, title: `PH ${randomUUID()}` } });
  listingIds.push(l.id);
  return l.id;
};

describe("lowestInWindow (pure)", () => {
  const at = new Date("2026-09-30T00:00:00Z");
  const ws = new Date(at.getTime() - 30 * DAY);
  const row = (daysAgo: number, pricePaise: number | null) => ({ pricePaise, effectiveFrom: new Date(at.getTime() - daysAgo * DAY) });

  it("is null without a full 30 days of history or without rows", () => {
    expect(cat.lowestInWindow([], ws, at)).toBeNull();
    expect(cat.lowestInWindow([row(10, 100)], ws, at)).toBeNull();
  });
  it("counts the price in force when the window opened, and ignores older lows", () => {
    // 50 was the price 60 days ago until 40 days ago; 100 since. Window (30d) only sees 100.
    expect(cat.lowestInWindow([row(60, 50), row(40, 100)], ws, at)).toBe(100);
    // 80 in force from 45 days ago until 5 days ago straddles the window start, then 120: low is 80
    expect(cat.lowestInWindow([row(45, 80), row(5, 120)], ws, at)).toBe(80);
  });
  it("a price raised just before a sale cannot inflate the reference", () => {
    expect(cat.lowestInWindow([row(90, 100), row(2, 300)], ws, at)).toBe(100);
  });
  it("ignores null (price removed) rows", () => {
    expect(cat.lowestInWindow([row(40, 100), row(10, null)], ws, at)).toBe(100);
    expect(cat.lowestInWindow([row(40, null)], ws, at)).toBeNull();
  });
  it("property: never above any price that was in force during the window", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 300; n++) {
      const k = 1 + Math.floor(rnd() * 6);
      const days = Array.from({ length: k }, () => Math.floor(rnd() * 120)).sort((a, b) => b - a);
      days[0] = Math.max(days[0]!, 31); // full history
      const rows = days.map((d) => row(d, 1 + Math.floor(rnd() * 1000)));
      const ref = cat.lowestInWindow(rows, ws, at)!;
      rows.forEach((r, i) => {
        const end = rows[i + 1]?.effectiveFrom ?? at;
        if (end > ws) expect(ref).toBeLessThanOrEqual(r.pricePaise!);
      });
      expect(rows.some((r) => r.pricePaise === ref)).toBe(true);
    }
  });
});

describe("price history (DB)", () => {
  it("records only on change, in order", async () => {
    const id = await mkListing();
    expect(await cat.recordPrice(id, 1000, "piece")).toBe(true);
    expect(await cat.recordPrice(id, 1000, "piece")).toBe(false);
    expect(await cat.recordPrice(id, 900, "piece")).toBe(true);
    expect(await cat.recordPrice(id, 900, "kg")).toBe(true);
    expect(await cat.recordPrice(id, null, null)).toBe(true);
    expect((await cat.priceHistory(id)).map((h) => h.pricePaise)).toEqual([null, 900, 900, 1000]);
  });

  it("referencePrice is null for < 30 days of history and the true low otherwise", async () => {
    const id = await mkListing();
    const now = new Date();
    await cat.recordPrice(id, 1000, "piece", undefined, new Date(now.getTime() - 10 * DAY));
    expect(await cat.referencePrice(id, now)).toBeNull();
    const id2 = await mkListing();
    await cat.recordPrice(id2, 1000, "piece", undefined, new Date(now.getTime() - 50 * DAY));
    await cat.recordPrice(id2, 700, "piece", undefined, new Date(now.getTime() - 20 * DAY));
    await cat.recordPrice(id2, 1500, "piece", undefined, new Date(now.getTime() - 1 * DAY));
    expect(await cat.referencePrice(id2, now)).toBe(700);
    // as of 35 days ago the window was [65d, 35d ago]: only the 1000 row applied there
    expect(await cat.referencePrice(id2, new Date(now.getTime() - 35 * DAY))).toBeNull();
  });

  it("publishing a version appends history only when the published price changed", async () => {
    const l = await cat.createListing(seller, { categoryId: catId, title: `PH pub ${tag}`, description: `price history publish description ${tag}`, attributes: {}, pricePaise: 1000, priceUnit: "piece", moq: 10, moqUnit: "piece", hsn: null, language: "en", imageUrls: [] });
    listingIds.push(l.id);
    await cat.publishVersion((await cat.submitListingVersion(seller, l.id)).id); // not the global sweep: it would race other files' versions
    expect((await cat.priceHistory(l.id)).map((h) => h.pricePaise)).toEqual([1000]);
    await cat.updateListing(seller, l.id, { title: `PH pub renamed ${tag}` });
    await cat.publishVersion((await cat.submitListingVersion(seller, l.id)).id); // not the global sweep: it would race other files' versions
    expect((await cat.priceHistory(l.id)).length).toBe(1); // title-only change: no new row
    await cat.updateListing(seller, l.id, { pricePaise: 800 });
    await cat.publishVersion((await cat.submitListingVersion(seller, l.id)).id); // not the global sweep: it would race other files' versions
    expect((await cat.priceHistory(l.id)).map((h) => h.pricePaise)).toEqual([800, 1000]);
  });

  it("emits a versioned ListingPriceChanged only for a real change (never the first publish or a title-only edit)", async () => {
    const l = await cat.createListing(seller, { categoryId: catId, title: `PH evt ${tag}`, description: `price change event description ${tag}`, attributes: {}, pricePaise: 1000, priceUnit: "piece", moq: 10, moqUnit: "piece", hsn: null, language: "en", imageUrls: [] });
    listingIds.push(l.id);
    const changed = () => prisma.domainEvent.findMany({ where: { aggregateId: l.id, type: "ListingPriceChanged" }, orderBy: { id: "asc" } });
    await cat.publishVersion((await cat.submitListingVersion(seller, l.id)).id);
    expect(await changed()).toHaveLength(0);
    await cat.updateListing(seller, l.id, { title: `PH evt renamed ${tag}` });
    await cat.publishVersion((await cat.submitListingVersion(seller, l.id)).id);
    expect(await changed()).toHaveLength(0);
    await cat.updateListing(seller, l.id, { pricePaise: 800 });
    await cat.publishVersion((await cat.submitListingVersion(seller, l.id)).id);
    const ev = await changed();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.version).toBe(1);
    expect(ev[0]!.payload).toMatchObject({ listingId: l.id, fromPricePaise: 1000, toPricePaise: 800, fromPriceUnit: "piece", priceUnit: "piece" });
  });
});
