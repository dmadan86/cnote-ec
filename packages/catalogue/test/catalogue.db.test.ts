import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM, prisma } from "@cnote/db";
import { liveDb, toVectorLiteral } from "@cnote/live-db";

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

// Seeds an authoring listing; published ones are projected into LIVE (as the backfill/publisher would) with a chosen embedding.
async function seedListing(key: string, sellerIdx: number, title: string, axis: number, tilt: number, status = "published", moderation = "approved") {
  const l = await prisma.listing.create({
    data: { sellerBusinessId: biz[sellerIdx]!, categoryId: catId, title: `${title} ${tag}`, description: `${title} description text ${tag}`, status: status as never, moderationStatus: moderation as never },
  });
  listings[key] = l.id;
  if (status !== "published") return;
  await cat.backfillLiveListings({ listingIds: [l.id] });
  await liveDb.$executeRaw`UPDATE live_listings SET embedding = ${toVectorLiteral(vec(axis, tilt))}::vector, embedding_version = 'test-v1' WHERE id = ${l.id}::uuid`;
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
  const ids = (await prisma.listing.findMany({ where: { sellerBusinessId: { in: biz } }, select: { id: true } })).map((l) => l.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await liveDb.liveListing.deleteMany({ where: { id: { in: ids } } });
  await liveDb.projectionCheckpoint.deleteMany({});
  await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { sellerBusinessId: { in: biz } } } }).catch(() => {});
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

const blank = { attributes: { ply: 3 }, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageUrls: [] };

describe("listing lifecycle (versioned)", () => {
  it("draft from text → submit is NOT live → staff approves → publisher projects to LIVE with an embedding", async () => {
    const draft = await cat.draftListingFromText(biz[0]!, "kraft boxes 100 pcs", "en");
    expect(draft.aiGenerated).toBe(true);
    expect(draft.status).toBe("draft");
    await expect(cat.updateListing(biz[1]!, draft.id, { title: "x" })).rejects.toMatchObject({ code: "forbidden" });
    const moved = await cat.updateListing(biz[0]!, draft.id, { categoryId: catId, attributes: { ply: "3" } });
    const sub = await cat.publishListing(biz[0]!, moved.id); // compat: submits a version
    expect(sub.status).toBe("draft");
    const [v1] = await cat.listListingVersions(biz[0]!, moved.id);
    expect(v1).toMatchObject({ version: 1, status: "in_review" }); // untrusted seller → staff review
    expect(await cat.getPublicListing(moved.id)).toBeNull();
    await cat.reviewListingVersion(v1!.id, "approved", "looks fine", randomUUID());
    expect(await cat.getPublicListing(moved.id)).toBeNull(); // approved ≠ live until the publisher runs
    expect(await cat.publishVersion(v1!.id)).toBe("published");
    expect(await cat.publishVersion(v1!.id)).toBe("skipped"); // idempotent
    const live = await cat.getPublicListing(moved.id);
    expect(live).toMatchObject({ status: "published", moderationStatus: "approved", liveVersion: 1 });
    const [row] = await liveDb.$queryRaw<{ v: string; has: boolean }[]>`SELECT embedding_version v, embedding IS NOT NULL has FROM live_listings WHERE id = ${draft.id}::uuid`;
    expect(row).toEqual({ v: "test-v1", has: true });
    expect(await cat.getListing(moved.id)).toMatchObject({ status: "published", moderationStatus: "approved" });
    listings.draft = draft.id;
  });
  it("blocks bad content (version rejected) and missing required attributes", async () => {
    const l = await cat.createListing(biz[2]!, { categoryId: catId, title: "Toy gun replica", description: "A very realistic gun toy", ...blank });
    listings.gun = l.id;
    const r = await cat.publishListing(biz[2]!, l.id);
    expect(r).toMatchObject({ status: "draft", moderationStatus: "rejected", moderationReason: "weapons" });
    expect((await cat.listListingVersions(biz[2]!, l.id))[0]).toMatchObject({ status: "rejected", reviewNote: "weapons" });
    const noAttr = await cat.createListing(biz[2]!, { categoryId: catId, title: "Box no ply", description: "Box without attributes set", ...blank, attributes: {} });
    listings.noAttr = noAttr.id;
    await expect(cat.publishListing(biz[2]!, noAttr.id)).rejects.toMatchObject({ code: "validation" });
  });
  it("review verdict stays invisible until approved+published; edits never touch live until a new version goes live", async () => {
    const l = await cat.createListing(biz[2]!, { categoryId: catId, title: "Suspicious box", description: "Suspicious packaging box lot", ...blank, attributes: { ply: 5 } });
    listings.rev = l.id;
    await cat.publishListing(biz[2]!, l.id);
    const [v1] = await cat.listListingVersions(biz[2]!, l.id);
    expect(v1).toMatchObject({ status: "in_review" });
    expect((await cat.listVersionReviewQueue()).items.map((i) => i.versionId)).toContain(v1!.id);
    let r = await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 10 });
    expect(r.map((x) => x.sellerBusinessId)).not.toContain(biz[2]);
    await cat.resolveListingModeration(l.id, "approved"); // legacy entry point → version review
    await cat.publishVersion(v1!.id);
    r = await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 10 });
    expect(r.map((x) => x.sellerBusinessId)).toContain(biz[2]);
    // editing the working copy does not change what buyers see
    await cat.updateListing(biz[2]!, l.id, { description: "Now a gun box lot" });
    expect((await cat.getPublicListing(l.id))!.description).toBe("Suspicious packaging box lot");
    // a blocked resubmission is rejected; the previous live version stays live
    await cat.submitListingVersion(biz[2]!, l.id, { changeNote: "edit" });
    const [v2] = await cat.listListingVersions(biz[2]!, l.id);
    expect(v2).toMatchObject({ version: 2, status: "rejected" });
    expect((await cat.getPublicListing(l.id))!.description).toBe("Suspicious packaging box lot");
    await cat.archiveListing(biz[2]!, l.id);
    expect((await cat.getListing(l.id))!.status).toBe("archived");
    expect(await cat.getPublicListing(l.id)).toBeNull();
    expect(await liveDb.liveListing.count({ where: { id: l.id } })).toBe(0);
  });
  it("prohibited categories are always rejected", async () => {
    const bad = (await cat.listCategories()).find((c) => c.slug === `t-bad-${tag}`)!;
    const l = await cat.createListing(biz[2]!, { categoryId: bad.id, title: "Anything", description: "Anything goes here ok", ...blank, attributes: {} });
    listings.bad = l.id;
    expect((await cat.publishListing(biz[2]!, l.id)).moderationStatus).toBe("rejected");
  });
  it("getListingsByIds preserves order", async () => {
    const r = await cat.getListingsByIds([listings.b1!, listings.a1!, randomUUID()]);
    expect(r.map((x) => x.id)).toEqual([listings.b1, listings.a1]);
  });
});
