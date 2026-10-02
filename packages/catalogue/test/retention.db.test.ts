import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@cnote/db";
import { LocalMediaStore, setMediaStore } from "@cnote/media";

vi.mock("@cnote/ai", () => ({ embed: async (t: string[]) => ({ vectors: t.map(() => []), version: "t" }), moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false }) }));

const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
let dir = "";
let store: LocalMediaStore;
let bizId = "";
let listingId = "";
let catId = "";
const imgIds: string[] = [];

async function image(deletedDays: number | null) {
  const id = randomUUID();
  const key = `listings/${listingId}/${id}.png`;
  await store.put(key, new Uint8Array([1, 2, 3]), "image/png");
  await prisma.listingImage.create({ data: { id, listingId, sellerBusinessId: bizId, storageKey: key, mimeType: "image/png", bytes: 3, sha256: id, deletedAt: deletedDays === null ? null : ago(deletedDays) } });
  imgIds.push(id);
  return { id, key };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ret-test-"));
  store = new LocalMediaStore(dir);
  setMediaStore(store);
  const [c] = await cat.upsertCategories([{ slug: `t-ret-${tag}`, name: "Test Ret" }]);
  catId = c!.id;
  bizId = (await prisma.business.create({ data: { name: `Ret ${tag}`, isSeller: true } })).id;
  listingId = (await prisma.listing.create({ data: { sellerBusinessId: bizId, categoryId: catId, title: `Ret ${tag}` } })).id;
});
afterAll(async () => {
  await prisma.listingImage.deleteMany({ where: { id: { in: imgIds } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { id: listingId } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { id: listingId } });
  await prisma.business.deleteMany({ where: { id: bizId } });
  // tolerate a foreign draft: draftListingFromText/Photos fall back to the first category in the DB, so a parallel file may still reference this one
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } }).catch(() => {});
  setMediaStore(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("purgeSoftDeletedImages", () => {
  it("purges bytes + rows of images soft-deleted before the cutoff only; dry-run counts; idempotent", async () => {
    const old = await image(500);
    const recent = await image(3);
    const live = await image(null);
    const cutoff = ago(400);
    expect(await cat.purgeSoftDeletedImages(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await store.exists(old.key)).toBe(true);
    expect(await cat.purgeSoftDeletedImages(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await store.exists(old.key)).toBe(false);
    expect(await prisma.listingImage.count({ where: { id: old.id } })).toBe(0);
    expect(await prisma.listingImage.count({ where: { id: { in: [recent.id, live.id] } } })).toBe(2);
    expect(await cat.purgeSoftDeletedImages(cutoff)).toBeGreaterThanOrEqual(0);
  });
});
