import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM, prisma } from "@cnote/db";
import { liveDb } from "@cnote/live-db";

const vec = (axis: number) => Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === axis ? 1 : 0));
vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => vec(0)), version: "test-v1" }),
  moderate: async (i: { text: string }) => ({ verdict: /gun/i.test(i.text) ? "block" : "allow", flags: [], reason: /gun/i.test(i.text) ? "weapons" : null, decisionId: "d", confidence: 0.9, needsReview: false }),
}));

process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret";
const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
let catId = "";
let trusted = "";
let plain = "";
const staff = randomUUID();
const input = (title: string, extra: Record<string, unknown> = {}) => ({
  categoryId: catId, title: `${title} ${tag}`, description: `${title} description long enough ${tag}`, attributes: { ply: 3 },
  pricePaise: 1000, priceUnit: "piece", moq: 10, moqUnit: "piece", hsn: null, language: "en", imageUrls: [], ...extra,
});

beforeAll(async () => {
  const [c] = await cat.upsertCategories([{ slug: `t-ver-${tag}`, name: "Test Versioned", attributeSchema: { fields: [{ key: "ply", label: "Ply", type: "number", required: true }] } }]);
  catId = c!.id;
  trusted = (await prisma.business.create({ data: { name: `Trusted ${tag}`, isSeller: true, verificationTier: 2, trustScore: 80 } })).id;
  plain = (await prisma.business.create({ data: { name: `Plain ${tag}`, isSeller: true } })).id;
});

afterAll(async () => {
  const ids = (await prisma.listing.findMany({ where: { sellerBusinessId: { in: [trusted, plain] } }, select: { id: true } })).map((l) => l.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await liveDb.liveListing.deleteMany({ where: { id: { in: ids } } });
  await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { id: { in: ids } } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: [trusted, plain] } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
});

const events = (listingId: string) => prisma.domainEvent.findMany({ where: { aggregateId: listingId }, orderBy: { id: "asc" } }).then((r) => r.map((e) => e.type));

describe("diffSnapshots", () => {
  it("reports field, attribute and image changes; first version diffs against nothing", () => {
    const a = { title: "A", description: "d", categoryId: "c", categoryName: "Cat", attributes: { ply: 3, color: "red" }, pricePaise: 100, priceUnit: null, moq: 1, moqUnit: null, hsn: null, language: "en", imageIds: ["i1"], imageUrls: [] };
    const b = { ...a, title: "B", attributes: { ply: 5 }, imageIds: ["i1", "i2"] };
    const d = cat.diffSnapshots(a, b);
    expect(d.map((x) => x.field).sort()).toEqual(["attributes.color", "attributes.ply", "images", "title"]);
    expect(d.find((x) => x.field === "title")).toMatchObject({ before: "A", after: "B" });
    expect(cat.diffSnapshots(null, a).length).toBeGreaterThan(3);
    expect(cat.diffSnapshots(a, a)).toEqual([]);
  });
});

describe("preview tokens", () => {
  it("verifies, expires and rejects tampering", () => {
    const id = randomUUID();
    const t = cat.createPreviewToken(id);
    expect(cat.verifyPreviewToken(t)).toEqual({ versionId: id });
    expect(cat.verifyPreviewToken(t, Date.now() + 3601_000)).toBeNull();
    expect(cat.verifyPreviewToken(t.replace(id, randomUUID()))).toBeNull();
    expect(cat.verifyPreviewToken(t.slice(0, -2) + "xx")).toBeNull();
    expect(cat.verifyPreviewToken("garbage")).toBeNull();
    expect(cat.verifyPreviewToken(null)).toBeNull();
  });
});

describe("version flow", () => {
  it("trusted seller + clean verdict auto-approves; publisher (event handler) takes it live; v2 supersedes v1", async () => {
    const l = await cat.createListing(trusted, input("Trusted widget"));
    const v1 = await cat.submitListingVersion(trusted, l.id, { changeNote: "first" });
    expect(v1).toMatchObject({ version: 1, status: "approved", reviewedBy: null });
    expect(await cat.getPublicListing(l.id)).toBeNull(); // not live yet
    await cat.worker.handlers.ListingVersionReviewed!({ id: 1, type: "ListingVersionReviewed", version: 1, aggregateType: "listing", aggregateId: l.id, occurredAt: new Date().toISOString(), payload: { listingId: l.id, versionId: v1.id, version: 1, sellerBusinessId: trusted, status: "approved", reviewedBy: null } } as never);
    expect(await cat.getPublicListing(l.id)).toMatchObject({ liveVersion: 1, title: `Trusted widget ${tag}`, seller: { name: `Trusted ${tag}`, verificationTier: 2 } });
    expect(await events(l.id)).toEqual(expect.arrayContaining(["ListingVersionSubmitted", "ListingVersionReviewed", "ListingVersionPublished", "ListingPublished"]));

    await expect(cat.submitListingVersion(trusted, l.id)).rejects.toMatchObject({ code: "conflict" }); // nothing changed
    await cat.updateListing(trusted, l.id, { title: `Trusted widget v2 ${tag}` });
    const ov = await cat.getVersionOverview(trusted, l.id);
    expect(ov.live?.version).toBe(1);
    expect(ov.unsubmittedChanges.map((c) => c.field)).toEqual(["title"]);
    const v2 = await cat.submitListingVersion(trusted, l.id, { changeNote: "rename" });
    expect(v2.changes.map((c) => c.field)).toEqual(["title"]);
    expect((await cat.getPublicListing(l.id))!.title).toBe(`Trusted widget ${tag}`); // v1 still live
    expect(await cat.publishDueVersions()).toBeGreaterThanOrEqual(1); // the 30s sweep
    expect(await cat.getPublicListing(l.id)).toMatchObject({ liveVersion: 2, title: `Trusted widget v2 ${tag}` });
    const hist = await cat.listListingVersions(trusted, l.id);
    expect(hist.map((h) => [h.version, h.status])).toEqual([[2, "published"], [1, "superseded"]]);
    expect((await prisma.listing.findUnique({ where: { id: l.id } }))!.liveVersionId).toBe(v2.id);
    expect(await events(l.id).then((e) => e.filter((x) => x === "ListingPublished").length)).toBe(1);
  });

  it("scheduled versions wait for publishAt; a newer submission withdraws the open one; withdraw works", async () => {
    const l = await cat.createListing(trusted, input("Scheduled widget"));
    const later = new Date(Date.now() + 3600_000);
    const s1 = await cat.submitListingVersion(trusted, l.id, { publishAt: later });
    expect(s1.status).toBe("approved");
    expect(await cat.publishVersion(s1.id)).toBe("not_due");
    expect(await cat.publishVersion(s1.id, new Date(later.getTime() + 1000))).toBe("published");
    await cat.updateListing(trusted, l.id, { description: `changed description long enough ${tag}` });
    const s2 = await cat.submitListingVersion(trusted, l.id, { publishAt: new Date(Date.now() + 7200_000) });
    await cat.updateListing(trusted, l.id, { description: `changed again description long ${tag}` });
    const s3 = await cat.submitListingVersion(trusted, l.id);
    expect((await cat.listListingVersions(trusted, l.id)).find((v) => v.id === s2.id)).toMatchObject({ status: "withdrawn" });
    await expect(cat.withdrawVersion(trusted, s2.id)).rejects.toMatchObject({ code: "conflict" });
    await cat.withdrawVersion(trusted, s3.id);
    expect(await cat.publishVersion(s3.id)).toBe("skipped");
    expect((await cat.getPublicListing(l.id))!.liveVersion).toBe(1);
  });

  it("untrusted → review queue; reject needs a note and leaves live untouched; monotonic LIVE write", async () => {
    const l = await cat.createListing(plain, input("Plain widget"));
    const v1 = await cat.submitListingVersion(plain, l.id);
    expect(v1.status).toBe("in_review");
    await expect(cat.reviewListingVersion(v1.id, "rejected", "  ", staff)).rejects.toMatchObject({ code: "validation" });
    const rej = await cat.reviewListingVersion(v1.id, "rejected", "Photos missing", staff);
    expect(rej).toMatchObject({ status: "rejected", reviewNote: "Photos missing", reviewedBy: staff });
    expect(await cat.getListing(l.id)).toMatchObject({ status: "draft", moderationStatus: "rejected", moderationReason: "Photos missing" });
    await expect(cat.reviewListingVersion(v1.id, "approved", null, staff)).rejects.toMatchObject({ code: "conflict" });

    await cat.updateListing(plain, l.id, { title: `Plain widget fixed ${tag}` });
    const v2 = await cat.submitListingVersion(plain, l.id);
    await cat.reviewListingVersion(v2.id, "approved", null, staff);
    expect(await cat.publishVersion(v2.id)).toBe("published");
    // an older projection can never overwrite a newer LIVE row
    const { writeLive } = await import("../src/live");
    const row = await liveDb.liveListing.findUniqueOrThrow({ where: { id: l.id } });
    await writeLive({ listingId: l.id, versionId: v1.id, version: 1, sellerBusinessId: plain, snap: { title: "STALE", description: "x", categoryId: catId, categoryName: "c", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageIds: [], imageUrls: [] }, category: { id: catId, slug: `t-ver-${tag}`, name: "Test Versioned" }, images: [], seller: { name: "s", city: null, state: null, tier: 0, trustScore: 0, badgeActive: false }, aiGenerated: false, embedding: vec(0), embeddingVersion: "x", publishedAt: new Date() });
    expect((await liveDb.liveListing.findUniqueOrThrow({ where: { id: l.id } })).title).toBe(row.title);
  });

  it("previews (owner + token), seller snapshot re-projection, unpublish", async () => {
    const l = await cat.createListing(trusted, input("Preview widget"));
    const v = await cat.submitListingVersion(trusted, l.id);
    expect(await cat.getVersionPreview(trusted, v.id)).toMatchObject({ title: `Preview widget ${tag}`, status: "draft", preview: { version: 1, versionStatus: "approved" } });
    await expect(cat.getVersionPreview(plain, v.id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await cat.getPreviewByToken(cat.createPreviewToken(v.id)))!.preview.versionId).toBe(v.id);
    expect(await cat.getPreviewByToken("nope")).toBeNull();

    await cat.publishVersion(v.id);
    await prisma.business.update({ where: { id: trusted }, data: { trustScore: 91, badgeActive: true } });
    expect(await cat.reprojectSeller(trusted)).toBeGreaterThanOrEqual(1);
    expect((await cat.getPublicListing(l.id))!.seller).toMatchObject({ trustScore: 91, badgeActive: true });

    await cat.unpublishListing(trusted, l.id);
    expect(await cat.getPublicListing(l.id)).toBeNull();
    expect(await cat.getListing(l.id)).toMatchObject({ status: "draft" });
    expect(await events(l.id)).toContain("ListingUnpublished");
    const { reconcileLive } = await import("../src/live");
    await expect(reconcileLive()).resolves.toBeDefined();
  });
});
