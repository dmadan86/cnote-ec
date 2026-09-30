import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@cnote/db";
import { LocalMediaStore, setMediaStore } from "@cnote/media";

vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => []), version: "t" }),
  moderate: async (i: { text: string }) => ({
    verdict: /gun/i.test(i.text) ? "block" : /suspicious/i.test(i.text) ? "review" : "allow",
    flags: [], reason: /gun|suspicious/i.test(i.text) ? "test" : null, decisionId: "d", confidence: 0.9, needsReview: false,
  }),
}));

const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
let dir = "";
let catId = "";
let store: LocalMediaStore;
const biz: string[] = [];
const staffId = randomUUID();
let live = "";
let draft = "";
let otherListing = "";

/** Unique valid PNG header (IHDR + salt) so each call has different bytes/sha. */
function png(salt: number, w = 400, h = 400) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  new DataView(b.buffer).setUint32(33, salt);
  return b;
}
const mk = (title: string, seller: number, status: "draft" | "published", moderation: "pending" | "approved", imageUrls: string[] = []) =>
  prisma.listing.create({ data: { sellerBusinessId: biz[seller]!, categoryId: catId, title: `${title} ${tag}`, description: `d ${tag}`, status, moderationStatus: moderation, imageUrls } }).then((l) => l.id);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "img-test-"));
  store = new LocalMediaStore(dir);
  setMediaStore(store);
  const [c] = await cat.upsertCategories([{ slug: `t-img-${tag}`, name: "Test Img" }]);
  catId = c!.id;
  for (const n of ["A", "B"]) biz.push((await prisma.business.create({ data: { name: `Img ${n} ${tag}`, isSeller: true } })).id);
  live = await mk("Live", 0, "published", "approved", ["https://placeholder.test/x.jpg"]);
  draft = await mk("Draft", 0, "draft", "pending");
  otherListing = await mk("Other", 1, "published", "approved");
});

afterAll(async () => {
  const ids = [live, draft, otherListing];
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: (await prisma.listingImage.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((i) => i.id) } } }).catch(() => {});
  await prisma.listingImage.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { sellerBusinessId: { in: biz } } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { sellerBusinessId: { in: biz } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
  setMediaStore(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("uploadListingImage", () => {
  it("stores bytes, creates a pending image and emits an event", async () => {
    const img = await cat.uploadListingImage(biz[0]!, live, { bytes: png(1), filename: "box.png", altText: "Kraft box" });
    expect(img.status).toBe("pending");
    expect(img.altText).toBe("Kraft box");
    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id: img.id } });
    expect(row.storageKey).toBe(`listings/${live}/${img.id}.png`);
    expect(await store.exists(row.storageKey)).toBe(true);
    const ev = await prisma.domainEvent.findFirst({ where: { type: "ListingImageUploaded", aggregateId: img.id } });
    expect(ev).toBeTruthy();
  });

  it("flags when the AI pre-screen objects, never auto-approves", async () => {
    const img = await cat.uploadListingImage(biz[0]!, live, { bytes: png(2), altText: "suspicious thing" });
    expect(img.status).toBe("flagged");
  });

  it("rejects non-images, tiny images and other sellers", async () => {
    await expect(cat.uploadListingImage(biz[0]!, live, { bytes: new TextEncoder().encode("<svg></svg> not an image at all") })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.uploadListingImage(biz[0]!, live, { bytes: png(3, 50, 50) })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.uploadListingImage(biz[1]!, live, { bytes: png(4) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(cat.uploadListingImage(biz[0]!, randomUUID(), { bytes: png(4) })).rejects.toMatchObject({ code: "not_found" });
  });

  it("dedupes and blocks re-upload of rejected bytes (even after delete)", async () => {
    const bytes = png(10);
    const a = await cat.uploadListingImage(biz[0]!, draft, { bytes });
    await expect(cat.uploadListingImage(biz[0]!, draft, { bytes })).rejects.toMatchObject({ code: "conflict" });
    await cat.moderateListingImage(a.id, "rejected", "Blurry", staffId);
    await expect(cat.uploadListingImage(biz[0]!, draft, { bytes })).rejects.toThrow(/rejected: Blurry/);
    await cat.deleteListingImage(biz[0]!, a.id);
    await expect(cat.uploadListingImage(biz[0]!, draft, { bytes })).rejects.toThrow(/rejected: Blurry/);
  });

  it("caps at 8 non-deleted images per listing", async () => {
    const l = await mk("Cap", 1, "draft", "pending");
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await cat.uploadListingImage(biz[1]!, l, { bytes: png(100 + i) })).id);
    await expect(cat.uploadListingImage(biz[1]!, l, { bytes: png(200) })).rejects.toMatchObject({ code: "conflict" });
    await cat.deleteListingImage(biz[1]!, ids[0]!);
    await expect(cat.uploadListingImage(biz[1]!, l, { bytes: png(200) })).resolves.toBeTruthy();
    await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.listingImage.deleteMany({ where: { listingId: l } });
    await prisma.listing.delete({ where: { id: l } });
  });
});

describe("moderation + visibility", () => {
  let id = "";
  it("requires a note to reject and transitions with events + before/after", async () => {
    id = (await cat.uploadListingImage(biz[0]!, live, { bytes: png(20), altText: "Approved shot" })).id;
    await expect(cat.moderateListingImage(id, "rejected", "  ", staffId)).rejects.toMatchObject({ code: "validation" });
    // pending is invisible to buyers and to a foreign seller
    expect(await cat.readListingImage(id, { kind: "public" })).toBeNull();
    expect(await cat.readListingImage(id, { kind: "seller", sellerBusinessId: biz[1]! })).toBeNull();
    expect(await cat.readListingImage(id, { kind: "seller", sellerBusinessId: biz[0]! })).toMatchObject({ contentType: "image/png" });
    expect(await cat.readListingImage(id, { kind: "staff" })).toBeTruthy();

    const r = await cat.moderateListingImage(id, "approved", null, staffId);
    expect(r.before.status).toBe("pending");
    expect(r.after.status).toBe("approved");
    await expect(cat.moderateListingImage(id, "approved", null, staffId)).rejects.toMatchObject({ code: "conflict" });
    const ev = await prisma.domainEvent.findFirst({ where: { type: "ListingImageModerated", aggregateId: id } });
    expect(ev?.payload).toMatchObject({ status: "approved", moderatedBy: staffId });
    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id } });
    expect(row.moderatedBy).toBe(staffId);
  });

  it("public sees approved images only on live listings", async () => {
    expect(await cat.readListingImage(id, { kind: "public" })).toBeTruthy();
    await prisma.listing.update({ where: { id: live }, data: { status: "archived" } });
    expect(await cat.readListingImage(id, { kind: "public" })).toBeNull();
    await prisma.listing.update({ where: { id: live }, data: { status: "published", moderationStatus: "review" } });
    expect(await cat.readListingImage(id, { kind: "public" })).toBeNull();
    await prisma.listing.update({ where: { id: live }, data: { status: "published", moderationStatus: "approved" } });
    expect(await cat.readListingImage(id, { kind: "public" })).toBeTruthy();
    // draft listing: approved image still not public
    const d = await cat.uploadListingImage(biz[0]!, draft, { bytes: png(21) });
    await cat.moderateListingImage(d.id, "approved", null, staffId);
    expect(await cat.readListingImage(d.id, { kind: "public" })).toBeNull();
  });

  it("ListingView.imageUrls: approved only, else placeholder fallback; getListing never leaks pending", async () => {
    const before = await cat.getListing(live);
    expect(before!.imageUrls).toEqual([`/media/listing-images/${id}`]);
    expect(before!.images).toBeUndefined();
    const other = await cat.getListing(otherListing);
    expect(other!.imageUrls).toEqual([]);
    // un-approve (reject) → placeholder fallback
    await cat.moderateListingImage(id, "rejected", "Watermark", staffId);
    const after = await cat.getListing(live);
    expect(after!.imageUrls).toEqual(["https://placeholder.test/x.jpg"]);
    const seller = await cat.getListingForSeller(biz[0]!, live);
    expect(seller!.images.find((i) => i.id === id)).toMatchObject({ status: "rejected", moderationNote: "Watermark" });
    expect(await cat.getListingForSeller(biz[1]!, live)).toBeNull();
  });
});

describe("seller edits", () => {
  it("alt text edit sends an approved image back to pending; reorder; delete removes storage and access", async () => {
    const a = await cat.uploadListingImage(biz[1]!, otherListing, { bytes: png(30) });
    const b = await cat.uploadListingImage(biz[1]!, otherListing, { bytes: png(31) });
    await cat.moderateListingImage(a.id, "approved", null, staffId);
    const edited = await cat.setImageAltText(biz[1]!, a.id, "New alt");
    expect(edited.status).toBe("pending");
    await expect(cat.setImageAltText(biz[0]!, a.id, "x")).rejects.toMatchObject({ code: "forbidden" });

    const re = await cat.reorderListingImages(biz[1]!, otherListing, [b.id, a.id]);
    expect(re.map((i) => i.id)).toEqual([b.id, a.id]);
    await expect(cat.reorderListingImages(biz[1]!, otherListing, [randomUUID()])).rejects.toMatchObject({ code: "validation" });

    const key = (await prisma.listingImage.findUniqueOrThrow({ where: { id: b.id } })).storageKey;
    await cat.deleteListingImage(biz[1]!, b.id);
    expect(await store.exists(key)).toBe(false);
    expect(await cat.readListingImage(b.id, { kind: "seller", sellerBusinessId: biz[1]! })).toBeNull();
    expect((await cat.listSellerListingImages(biz[1]!, otherListing)).map((i) => i.id)).toEqual([a.id]);
  });

  it("queue lists pending/flagged with listing + seller; purge removes old soft-deleted rows", async () => {
    const q = await cat.listImageModerationQueue({ limit: 100 });
    const mine = q.items.filter((i) => [live, draft, otherListing].includes(i.listingId));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((i) => i.status === "pending" || i.status === "flagged")).toBe(true);
    expect(mine[0]!.sellerName).toMatch(/^Img /);
    const flagged = await cat.listImageModerationQueue({ status: "flagged", limit: 100 });
    expect(flagged.items.every((i) => i.status === "flagged")).toBe(true);

    const x = await cat.uploadListingImage(biz[1]!, otherListing, { bytes: png(40) });
    await cat.deleteListingImage(biz[1]!, x.id);
    await prisma.listingImage.update({ where: { id: x.id }, data: { deletedAt: new Date(Date.now() - 31 * 864e5) } });
    await cat.purgeDeletedListingImages();
    expect(await prisma.listingImage.findUnique({ where: { id: x.id } })).toBeNull();
  });
});
