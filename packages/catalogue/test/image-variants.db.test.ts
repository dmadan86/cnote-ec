import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { LocalMediaStore, setMediaStore, solidJpeg } from "@cnote/media";

vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => []), version: "t" }),
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 0.9, needsReview: false }),
}));

const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
const staffId = randomUUID();
let dir = "";
let priv: LocalMediaStore;
let pub: LocalMediaStore;
let queue: MemoryJobQueue;
let biz = "";
let listing = "";
let catId = "";

const photo = (seed: number) => solidJpeg(1000, 700, [seed % 255, 90, 40]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "variants-test-"));
  priv = new LocalMediaStore(path.join(dir, "priv"), "private");
  pub = new LocalMediaStore(path.join(dir, "pub"), "public");
  setMediaStore(priv);
  setMediaStore(pub, "public");
  queue = new MemoryJobQueue();
  setJobQueue(queue);
  const [c] = await cat.upsertCategories([{ slug: `t-var-${tag}`, name: "Test Var" }]);
  catId = c!.id;
  biz = (await prisma.business.create({ data: { name: `Var ${tag}`, isSeller: true } })).id;
  listing = (await prisma.listing.create({ data: { sellerBusinessId: biz, categoryId: catId, title: `Var ${tag}`, description: "d", status: "published", moderationStatus: "approved" } })).id;
});

afterAll(async () => {
  const ids = (await prisma.listingImage.findMany({ where: { listingId: listing }, select: { id: true } })).map((i) => i.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await prisma.listingImage.deleteMany({ where: { listingId: listing } });
  await prisma.listing.deleteMany({ where: { sellerBusinessId: biz } });
  await prisma.business.deleteMany({ where: { id: biz } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
  setMediaStore(undefined);
  setJobQueue(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("image variants lifecycle", () => {
  it("approve enqueues, processing writes public variants, reject removes them", async () => {
    const img = await cat.uploadListingImage(biz, listing, { bytes: await photo(10), altText: "Box" });
    expect(await cat.publicImagesForListing(listing)).toEqual([]);

    await cat.moderateListingImage(img.id, "approved", null, staffId);
    // Enqueue is best effort; drain the queue like the worker would.
    let handled = 0;
    await queue.consume("media.process_image", "test", "c1", async (m) => { handled++; expect(await cat.processListingImage(m.payload.imageId)).toBe("processed"); });
    expect(handled).toBe(1);

    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id: img.id } });
    expect(row.processedAt).toBeTruthy();
    expect(row.blurDataUrl?.length).toBeLessThanOrEqual(1024);
    const variants = row.variants as { key: string; format: string; width: number }[];
    expect(variants.length).toBe(12); // 1000px original: 160,320,640,960 x avif,webp,jpeg
    for (const v of variants) expect(await pub.exists(v.key)).toBe(true);
    expect(await priv.exists(row.storageKey)).toBe(true); // original stays private
    expect(await pub.exists(row.storageKey)).toBe(false);
    expect(await prisma.domainEvent.findFirst({ where: { type: "ListingImageProcessed", aggregateId: img.id } })).toBeTruthy();

    const [pi] = await cat.publicImagesForListing(listing);
    expect(pi!.src).toMatch(/^\/media\/v\/listings\/.+\/960\.jpg$/);
    expect(pi!.srcSet).toContain("160w");
    expect(pi!.sources.map((s) => s.type)).toEqual(["image/avif", "image/webp"]);
    expect(pi!.blurDataUrl).toBeTruthy();
    expect(pi!.alt).toBe("Box");

    const d = await cat.getListingImageDelivery(img.id, { kind: "public" });
    expect(d).toMatchObject({ kind: "redirect" });
    expect(await cat.getListingImageDelivery(img.id, { kind: "seller", sellerBusinessId: biz })).toMatchObject({ kind: "bytes" });

    await cat.moderateListingImage(img.id, "rejected", "Nope", staffId);
    for (const v of variants) expect(await pub.exists(v.key)).toBe(false);
    const after = await prisma.listingImage.findUniqueOrThrow({ where: { id: img.id } });
    expect(after.processedAt).toBeNull();
    expect(await cat.publicImagesForListing(listing)).toEqual([]);
  });

  it("unprocessed approved images fall back to the /media route; backfill processes them", async () => {
    const img = await cat.uploadListingImage(biz, listing, { bytes: await photo(50) });
    await prisma.listingImage.update({ where: { id: img.id }, data: { status: "approved" } });
    const [pi] = await cat.publicImagesForListing(listing);
    expect(pi).toMatchObject({ src: `/media/listing-images/${img.id}`, srcSet: "", sources: [] });
    const r = await cat.backfillImageVariants();
    expect(r.processed).toBeGreaterThanOrEqual(1);
    expect((await cat.publicImagesForListing(listing))[0]!.srcSet).toContain("w");
  });

  it("skips images that are no longer approved and deleting removes variants", async () => {
    const img = await cat.uploadListingImage(biz, listing, { bytes: await photo(90) });
    expect(await cat.processListingImage(img.id)).toBe("skipped"); // pending
    await prisma.listingImage.update({ where: { id: img.id }, data: { status: "approved" } });
    expect(await cat.processListingImage(img.id)).toBe("processed");
    const keys = ((await prisma.listingImage.findUniqueOrThrow({ where: { id: img.id } })).variants as { key: string }[]).map((v) => v.key);
    await cat.deleteListingImage(biz, img.id);
    for (const k of keys) expect(await pub.exists(k)).toBe(false);
  });
});
