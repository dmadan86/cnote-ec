import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@cnote/db";

vi.mock("@cnote/ai", () => ({ embed: async () => ({ vectors: [[0]], version: "x" }), moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 1, needsReview: false }) }));
const cat = await import("../src/index");
const { projectImages } = await import("../src/live");
const { findSellerListingsBySkus } = await import("../src/sku");
const tag = randomUUID().slice(0, 8);
const bizIds: string[] = [];

afterAll(async () => {
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { sellerBusinessId: { in: bizIds } } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { sellerBusinessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.category.updateMany({ where: { slug: { endsWith: tag }, parentId: { not: null } }, data: { parentId: null } });
  // tolerate a foreign draft: draftListingFromText/Photos fall back to the first category in the DB, so a parallel file may still reference this one
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } }).catch(() => {});
});

describe("upsertCategories", () => {
  it("writes parents before children regardless of input order; idempotent update", async () => {
    const defs = [
      { slug: `child-${tag}`, name: "Child", parentSlug: `parent-${tag}`, leadCap: 5 },
      { slug: `parent-${tag}`, name: "Parent", icon: "box", prohibited: false },
    ];
    const out = await cat.upsertCategories(defs);
    expect(out.map((c) => c.slug)).toEqual([`parent-${tag}`, `child-${tag}`]);
    const [p, c] = out;
    expect(c).toMatchObject({ parentId: p!.id, leadCap: 5 });
    expect(p).toMatchObject({ icon: "box", leadCap: 3, attributeSchema: { fields: [] } });
    const again = await cat.upsertCategories([{ ...defs[1]!, name: "Parent 2" }]);
    expect(again[0]!.id).toBe(p!.id);
    expect((await cat.getCategoryBySlug(`parent-${tag}`))!.name).toBe("Parent 2");
  });
  it("resolves a parent that already exists in the DB", async () => {
    const [c] = await cat.upsertCategories([{ slug: `late-${tag}`, name: "Late", parentSlug: `parent-${tag}` }]);
    expect(c!.parentId).toBe((await cat.getCategoryBySlug(`parent-${tag}`))!.id);
  });
  it("detects parent cycles and unknown parents", async () => {
    await expect(cat.upsertCategories([{ slug: `a-${tag}`, name: "A", parentSlug: `b-${tag}` }, { slug: `b-${tag}`, name: "B", parentSlug: `a-${tag}` }])).rejects.toThrow(/cycle/);
    await expect(cat.upsertCategories([{ slug: `x-${tag}`, name: "X", parentSlug: `nope-${tag}` }])).rejects.toThrow(/unknown parentSlug/);
  });
  it("lookups: unknown slug null; getCategoryById falls back to DB for a category newer than the cache", async () => {
    expect(await cat.getCategoryBySlug(`missing-${tag}`)).toBeNull();
    expect(await cat.getCategoryById(randomUUID())).toBeNull();
    const row = await prisma.category.create({ data: { slug: `fresh-${tag}`, name: "Fresh", attributeSchema: { fields: [] } } }); // bypasses cache invalidation
    expect((await cat.getCategoryById(row.id))!.slug).toBe(`fresh-${tag}`);
  });
});

describe("projectImages", () => {
  it("placeholder urls pass through when the snapshot has no uploaded images; missing ids are dropped", async () => {
    const r = await projectImages(randomUUID(), { imageIds: [], imageUrls: ["https://x/y.jpg"] });
    expect(r).toEqual([{ id: null, src: "https://x/y.jpg", srcSet: "", width: 0, height: 0, blurDataUrl: null, alt: "", sources: [] }]);
    expect(await projectImages(randomUUID(), { imageIds: [randomUUID()], imageUrls: ["ignored"] })).toEqual([]);
  });
});

describe("findSellerListingsBySkus", () => {
  it("maps sku → id/status, only the seller's, chunks big lists", async () => {
    const mk = async (n: string) => { const b = await prisma.business.create({ data: { name: `${n} ${tag}`, isSeller: true } }); bizIds.push(b.id); return b.id; };
    const s = await mk("SkuA"); const t = await mk("SkuB");
    const c = (await cat.getCategoryBySlug(`parent-${tag}`))!;
    const mkl = (sid: string, sku: string | null, status: "draft" | "archived" = "draft") => prisma.listing.create({ data: { sellerBusinessId: sid, categoryId: c.id, title: `T ${sku}`, description: "d", sku, status } });
    const a = await mkl(s, "A1"); const b = await mkl(s, "A2", "archived"); await mkl(s, null); await mkl(t, "A1");
    const skus = ["A1", "A2", "ZZ", ...Array.from({ length: 1500 }, (_, i) => `N${i}`)];
    const m = await findSellerListingsBySkus(s, skus);
    expect(m.size).toBe(2);
    expect(m.get("A1")).toEqual({ id: a.id, status: "draft" });
    expect(m.get("A2")).toEqual({ id: b.id, status: "archived" });
    expect((await findSellerListingsBySkus(s, [])).size).toBe(0);
  });
});
