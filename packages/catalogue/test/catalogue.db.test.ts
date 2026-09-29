import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM, prisma, toVectorLiteral } from "@cnote/db";

// Deterministic fake AI: text containing "box" → axis 0, "shirt" → axis 1; moderation blocks "gun".
const vec = (axis: number, tilt = 0) => Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === axis ? 1 : i === axis + 1 ? tilt : 0));
vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map((t) => (/box/i.test(t) ? vec(0) : vec(1))), version: "test-v1" }),
  moderate: async (i: { text: string }) => ({
    verdict: /gun/i.test(i.text) ? "block" : /suspicious/i.test(i.text) ? "review" : "allow",
    flags: [], reason: /gun/i.test(i.text) ? "weapons" : null, decisionId: "d", confidence: 0.9, needsReview: false,
  }),
  extractListing: async () => ({ title: "Kraft boxes", description: "Corrugated kraft boxes for cosmetics", categorySlug: null, attributes: { ply: "3" }, pricePaise: 1500, priceUnit: "piece", moq: 100, moqUnit: "piece", hsn: null, decisionId: "d", confidence: 0.8, needsReview: false }),
}));

const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
let catId = "";
const biz: string[] = [];
const listings: Record<string, string> = {};

async function seedListing(key: string, sellerIdx: number, title: string, axis: number, tilt: number, status = "published", moderation = "approved") {
  const l = await prisma.listing.create({
    data: { sellerBusinessId: biz[sellerIdx]!, categoryId: catId, title: `${title} ${tag}`, description: `${title} description text ${tag}`, status: status as never, moderationStatus: moderation as never },
  });
  await prisma.$executeRaw`UPDATE listings SET embedding = ${toVectorLiteral(vec(axis, tilt))}::vector, embedding_version = 'test-v1' WHERE id = ${l.id}::uuid`;
  listings[key] = l.id;
}

beforeAll(async () => {
  const [c] = await cat.upsertCategories([
    { slug: `t-pack-${tag}`, name: "Test Packaging", attributeSchema: { fields: [{ key: "ply", label: "Ply", type: "number", required: true }] } },
    { slug: `t-bad-${tag}`, name: "Test Prohibited", prohibited: true },
  ]);
  catId = c!.id;
  for (const n of ["A", "B", "C"]) biz.push((await prisma.business.create({ data: { name: `Test ${n} ${tag}`, isSeller: true } })).id);
  await seedListing("a1", 0, "Cosmetic packaging box", 0, 0.1);
  await seedListing("a2", 0, "Pizza packaging box", 0, 0.9); // same seller, worse match
  await seedListing("b1", 1, "Gift packaging box", 0, 0.4);
  await seedListing("c1", 2, "Packaging box draft", 0, 0, "draft", "pending");
});

afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: Object.values(listings) } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { sellerBusinessId: { in: biz } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
});

describe("findSellerCandidates", () => {
  it("returns one best listing per seller ordered by similarity, live only", async () => {
    const r = await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 10 });
    expect(r.map((x) => x.sellerBusinessId)).toEqual([biz[0], biz[1]]);
    expect(r[0]!.listingId).toBe(listings.a1);
    expect(r[0]!.similarity).toBeGreaterThan(r[1]!.similarity);
  });
  it("honours excludeSellerIds", async () => {
    const r = await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 10, excludeSellerIds: [biz[0]!] });
    expect(r.map((x) => x.sellerBusinessId)).toEqual([biz[1]]);
  });
});

describe("retrieveListings", () => {
  it("returns lexical and vector scores, excluding drafts", async () => {
    const r = await cat.retrieveListings({ text: `cosmetic packaging ${tag}`, embedding: vec(0), categoryId: catId, limit: 10 });
    const ids = r.map((x) => x.listingId);
    expect(ids).not.toContain(listings.c1);
    const a1 = r.find((x) => x.listingId === listings.a1)!;
    const a2 = r.find((x) => x.listingId === listings.a2)!;
    expect(a1.lexicalRank).toBeGreaterThan(a2.lexicalRank); // "cosmetic" only in a1
    expect(a1.similarity).toBeGreaterThan(a2.similarity);
  });
  it("gives 0 lexical score to vector-only hits and supports prefix matching", async () => {
    const vecOnly = await cat.retrieveListings({ embedding: vec(0), categoryId: catId, limit: 10 });
    expect(vecOnly.every((x) => x.lexicalRank === 0)).toBe(true);
    const pre = await cat.retrieveListings({ text: `cosmet`, categoryId: catId, limit: 10 });
    expect(pre.map((x) => x.listingId)).toContain(listings.a1);
  });
});

describe("listing lifecycle", () => {
  it("draft from text → publish validates, moderates, embeds", async () => {
    const draft = await cat.draftListingFromText(biz[0]!, "kraft boxes 100 pcs", "en");
    expect(draft.aiGenerated).toBe(true);
    expect(draft.status).toBe("draft");
    // fallback picks the first non-prohibited category; force ours for a deterministic schema
    await expect(cat.updateListing(biz[1]!, draft.id, { title: "x" })).rejects.toMatchObject({ code: "forbidden" });
    const moved = await cat.updateListing(biz[0]!, draft.id, { categoryId: catId, attributes: { ply: "3" } });
    const pub = await cat.publishListing(biz[0]!, moved.id);
    expect(pub).toMatchObject({ status: "published", moderationStatus: "approved" });
    const [row] = await prisma.$queryRaw<{ v: string; has: boolean }[]>`SELECT embedding_version v, embedding IS NOT NULL has FROM listings WHERE id = ${draft.id}::uuid`;
    expect(row).toEqual({ v: "test-v1", has: true });
    listings.draft = draft.id;
  });
  it("blocks bad content and missing required attributes", async () => {
    const l = await cat.createListing(biz[2]!, { categoryId: catId, title: "Toy gun replica", description: "A very realistic gun toy", attributes: { ply: 3 }, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageUrls: [] });
    listings.gun = l.id;
    const r = await cat.publishListing(biz[2]!, l.id);
    expect(r).toMatchObject({ status: "draft", moderationStatus: "rejected", moderationReason: "weapons" });
    const noAttr = await cat.createListing(biz[2]!, { categoryId: catId, title: "Box no ply", description: "Box without attributes set", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageUrls: [] });
    listings.noAttr = noAttr.id;
    await expect(cat.publishListing(biz[2]!, noAttr.id)).rejects.toMatchObject({ code: "validation" });
  });
  it("review verdict publishes but stays invisible until approved; edits re-moderate", async () => {
    const l = await cat.createListing(biz[2]!, { categoryId: catId, title: "Suspicious box", description: "Suspicious packaging box lot", attributes: { ply: 5 }, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageUrls: [] });
    listings.rev = l.id;
    expect(await cat.publishListing(biz[2]!, l.id)).toMatchObject({ status: "published", moderationStatus: "review" });
    let r = await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 10 });
    expect(r.map((x) => x.sellerBusinessId)).not.toContain(biz[2]);
    await cat.resolveListingModeration(l.id, "approved");
    r = await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 10 });
    expect(r.map((x) => x.sellerBusinessId)).toContain(biz[2]);
    const edited = await cat.updateListing(biz[2]!, l.id, { description: "Now a gun box lot" });
    expect(edited).toMatchObject({ status: "draft", moderationStatus: "rejected" });
    await cat.archiveListing(biz[2]!, l.id);
    expect((await cat.getListing(l.id))!.status).toBe("archived");
  });
  it("prohibited categories are always rejected", async () => {
    const bad = (await cat.listCategories()).find((c) => c.slug === `t-bad-${tag}`)!;
    const l = await cat.createListing(biz[2]!, { categoryId: bad.id, title: "Anything", description: "Anything goes here ok", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageUrls: [] });
    listings.bad = l.id;
    expect((await cat.publishListing(biz[2]!, l.id)).moderationStatus).toBe("rejected");
  });
  it("getListingsByIds preserves order", async () => {
    const r = await cat.getListingsByIds([listings.b1!, listings.a1!, randomUUID()]);
    expect(r.map((x) => x.id)).toEqual([listings.b1, listings.a1]);
  });
});
