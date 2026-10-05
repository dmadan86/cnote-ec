import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";

vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => []), version: "t" }),
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 0.9, needsReview: false }),
}));

const catalogue = await import("@cnote/catalogue");
const bulk = await import("../src");

const tag = randomUUID().slice(0, 8);
const slug = `bulk-var-${tag}`;
const bizIds: string[] = [];
const store = new bulk.MemoryBulkStore();
const queue = new MemoryJobQueue();
const staff = randomUUID();

const HDR = "sku*,title*,category*,description,price_rupees,moq,availability,available_qty,lead_time_days,variant_sku,variant:size (Size),variant:colour (Colour)";
const file = (...lines: string[]) => new Uint8Array(Buffer.from([HDR, ...lines].join("\n")));
const prod = (sku: string, extra = ",,,") => `${sku},Shirt ${sku},${slug},A cotton shirt for bulk orders,100,10,${extra},,,`;
const vrow = (sku: string, vsku: string, size: string, colour: string, extra = "") => `${sku},,,,${extra || ",,,,"},${vsku},${size},${colour}`;
const OPTS = { mode: "upsert" as const, submitForReview: false };

async function actor() {
  const b = await prisma.business.create({ data: { name: `BulkVar ${bizIds.length} ${tag}`, isSeller: true } });
  bizIds.push(b.id);
  return { personId: randomUUID(), businessId: b.id };
}
async function run(a: Awaited<ReturnType<typeof actor>>, bytes: Uint8Array, opts: Partial<typeof OPTS> & { skipInvalid?: boolean } = {}) {
  const v = await bulk.createImportJob(a, { bytes, filename: "f.csv" }, { ...OPTS, ...opts });
  if (v.totalRows - v.errorCount === 0) return v;
  await bulk.confirmImportJob(a, v.id, { skipInvalid: opts.skipInvalid });
  await bulk.runImportJob(v.id);
  return bulk.getJob(a, v.id);
}
async function goLive(a: Awaited<ReturnType<typeof actor>>, sku: string) {
  const l = (await catalogue.findSellerListingBySku(a.businessId, sku))!;
  const v = await catalogue.submitListingVersion(a.businessId, l.id, {});
  if (v.status === "in_review") await catalogue.reviewListingVersion(v.id, "approved", null, staff);
  expect(await catalogue.publishVersion(v.id)).toBe("published");
  return l.id;
}

beforeAll(async () => {
  bulk.setBulkStore(store);
  setJobQueue(queue);
  await catalogue.upsertCategories([
    { slug, name: `Bulk Var ${tag}`, attributeSchema: { fields: [], variantAxes: [{ key: "size", label: "Size", options: ["S", "M", "L"] }, { key: "colour", label: "Colour" }] } },
  ]);
});

afterAll(async () => {
  const ids = (await prisma.listing.findMany({ where: { sellerBusinessId: { in: bizIds } }, select: { id: true } })).map((l) => l.id);
  const jobs = (await prisma.bulkJob.findMany({ where: { sellerBusinessId: { in: bizIds } }, select: { id: true } })).map((j) => j.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [...ids, ...jobs] } } }).catch(() => {});
  for (const l of await prisma.listing.findMany({ where: { id: { in: ids }, liveVersionId: { not: null } }, select: { id: true, sellerBusinessId: true } })) await catalogue.archiveListing(l.sellerBusinessId, l.id); // removes it from LIVE
  await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listingId: { in: ids } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.bulkJob.deleteMany({ where: { sellerBusinessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
  bulk.setBulkStore(undefined);
  setJobQueue(undefined);
});

describe("bulk stock columns", () => {
  it("new listings take availability, quantity and lead time; aliases are accepted", async () => {
    const a = await actor();
    const job = await run(a, file(prod("ST-1", "in stock,25,"), prod("ST-2", "Made to order,,14"), prod("ST-3", "out_of_stock,,")));
    expect(job).toMatchObject({ status: "completed", createdCount: 3 });
    expect(await catalogue.findSellerListingBySku(a.businessId, "ST-1")).toMatchObject({ availability: "in_stock", availableQty: 25 });
    expect(await catalogue.findSellerListingBySku(a.businessId, "ST-2")).toMatchObject({ availability: "made_to_order", trade: { leadTimeDays: 14 } });
    expect((await catalogue.findSellerListingBySku(a.businessId, "ST-3"))!.availability).toBe("out_of_stock");
  });

  it("validates per row: made_to_order needs a lead time, unknown values and bad quantities are reported", async () => {
    const a = await actor();
    const v = await bulk.createImportJob(a, { bytes: file(prod("BAD-1", "made_to_order,,"), prod("BAD-2", "maybe,,"), prod("BAD-3", "in_stock,-1,"), prod("BAD-4", "in_stock,,900")), filename: "f.csv" }, OPTS);
    expect(v.errorCount).toBe(4);
    const cols = v.sampleErrors.map((e) => e.column).sort();
    expect(cols).toEqual(["availability", "available_qty", "availability", "lead_time_days"].sort());
    expect(v.sampleErrors.find((e) => e.row === 2)!.message).toMatch(/lead time/i);
  });

  it("stock on a LIVE listing goes through the fast path: no new version, LIVE changes at once", async () => {
    const a = await actor();
    await run(a, file(prod("LV-1")));
    const id = await goLive(a, "LV-1");
    const versions = await prisma.listingVersion.count({ where: { listingId: id } });
    const job = await run(a, file(prod("LV-1", "out_of_stock,,")));
    expect(job.status).toBe("completed");
    expect(await prisma.listingVersion.count({ where: { listingId: id } })).toBe(versions);
    expect((await catalogue.getPublicListing(id))!.availability).toBe("out_of_stock");
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: id, type: "ListingAvailabilityChanged" } });
    expect(ev).toHaveLength(1);
  });
});

describe("bulk variants", () => {
  it("variant rows create a variant set; re-import replaces it; stock cells and tiers behave", async () => {
    const a = await actor();
    const job = await run(a, file(prod("VR-1"), vrow("VR-1", "VR-1-S-RED", "s", "Red"), vrow("VR-1", "VR-1-M-RED", "M", "Red", "150,20,made_to_order,,7")));
    expect(job).toMatchObject({ status: "completed", createdCount: 1, errorCount: 0 });
    const l = (await catalogue.findSellerListingBySku(a.businessId, "VR-1"))!;
    expect(l.variants!.map((v) => [v.sku, v.axisValues.size, v.pricePaise, v.moq, v.availability, v.leadTimeDays])).toEqual([
      ["VR-1-S-RED", "S", null, null, "in_stock", null],
      ["VR-1-M-RED", "M", 15000, 20, "made_to_order", 7],
    ]);
    const firstIds = new Map(l.variants!.map((v) => [v.sku, v.id]));

    // second import keeps M, drops S, adds L
    await run(a, file(vrow("VR-1", "VR-1-M-RED", "M", "Red", "160,20,,,"), vrow("VR-1", "VR-1-L-RED", "L", "Red")));
    const l2 = (await catalogue.findSellerListingBySku(a.businessId, "VR-1"))!;
    expect(l2.variants!.map((v) => v.sku)).toEqual(["VR-1-M-RED", "VR-1-L-RED"]);
    expect(l2.variants![0]!.id).toBe(firstIds.get("VR-1-M-RED"));
    expect(l2.variants![0]).toMatchObject({ pricePaise: 16000, availability: "made_to_order", leadTimeDays: 7 }); // blank stock cells keep stored values
  });

  it("reports variant row errors by row and applies none of that product's variants", async () => {
    const a = await actor();
    const v = await bulk.createImportJob(a, { bytes: file(prod("ER-1"), vrow("ER-1", "A", "S", "Red"), vrow("ER-1", "B", "XXL", "Red"), vrow("ER-1", "A", "M", "Red"), vrow("NOPE", "Z", "S", "Red")), filename: "f.csv" }, OPTS);
    const msgs = v.sampleErrors.map((e) => `${e.row}:${e.message}`).join("\n");
    expect(msgs).toMatch(/5:Duplicate variant SKU "A" \(also on row 3\)/);
    expect(msgs).toMatch(/6:Variant rows need a product/);
    const opt = await bulk.createImportJob(a, { bytes: file(prod("ER-2"), vrow("ER-2", "A", "XXL", "Red")), filename: "f.csv" }, OPTS);
    expect(opt.sampleErrors.map((e) => `${e.row}:${e.message}`).join()).toMatch(/3:Size must be one of: S, M, L/);
    const done = await run(a, file(prod("ER-1"), vrow("ER-1", "A", "S", "Red"), vrow("ER-1", "B", "XXL", "Red")), { skipInvalid: true });
    expect(done.status).toBe("completed_with_errors");
    expect((await catalogue.findSellerListingBySku(a.businessId, "ER-1"))!.variants).toEqual([]);
  });

  it("variant rows for an existing listing work without its product row, and the 100 cap holds", async () => {
    const a = await actor();
    await run(a, file(prod("VO-1")));
    const job = await run(a, file(vrow("VO-1", "VO-S", "S", "Blue")));
    expect(job).toMatchObject({ status: "completed", updatedCount: 1 });
    expect((await catalogue.findSellerListingBySku(a.businessId, "VO-1"))!.variants).toHaveLength(1);
    const many = Array.from({ length: 101 }, (_, i) => vrow("VO-1", `V${i}`, "S", `c${i}`));
    const v = await bulk.createImportJob(a, { bytes: file(...many), filename: "f.csv" }, OPTS);
    expect(v.sampleErrors.map((e) => e.message).join()).toMatch(/At most 100 variants/);
  });

  it("export writes variant rows below their product and the file imports back unchanged", async () => {
    const a = await actor();
    await run(a, file(prod("RT-1", "in_stock,40,"), vrow("RT-1", "RT-1-S", "S", "Red", "150,20,out_of_stock,,"), vrow("RT-1", "RT-1-M", "M", "Blue")));
    const out = await bulk.buildExport(a.businessId, { format: "csv", includeImages: false });
    const text = Buffer.from(out.bytes).toString("utf8");
    expect(text).toContain("variant_sku");
    expect(text).toContain("variant:size (Size)");
    expect(out.rows).toBe(3);
    const before = (await catalogue.findSellerListingBySku(a.businessId, "RT-1"))!;
    const job = await run(a, out.bytes);
    expect(job).toMatchObject({ status: "completed", errorCount: 0 });
    const after = (await catalogue.findSellerListingBySku(a.businessId, "RT-1"))!;
    expect(after.availableQty).toBe(40);
    expect(after.variants!.map((v) => [v.id, v.sku, v.axisValues, v.pricePaise, v.moq, v.availability])).toEqual(before.variants!.map((v) => [v.id, v.sku, v.axisValues, v.pricePaise, v.moq, v.availability]));
  });
});
