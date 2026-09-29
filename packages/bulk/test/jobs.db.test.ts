import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryJobQueue, setJobQueue, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { LocalMediaStore, setMediaStore } from "@cnote/media";

vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => []), version: "t" }),
  moderate: async () => ({ verdict: "allow", flags: [], reason: null, decisionId: "d", confidence: 0.9, needsReview: false }),
}));

const catalogue = await import("@cnote/catalogue");
const bulk = await import("../src");
const { csv, zip, png } = await import("./fixtures");

const tag = randomUUID().slice(0, 8);
const slug = `bulk-pipes-${tag}`;
const bizIds: string[] = [];
const queue = new MemoryJobQueue();
const store = new bulk.MemoryBulkStore();
let dir = "";
let catId = "";

async function actor() {
  const b = await prisma.business.create({ data: { name: `Bulk ${bizIds.length} ${tag}`, isSeller: true } });
  bizIds.push(b.id);
  return { personId: randomUUID(), businessId: b.id };
}
const HDR = "sku*,title*,category*,description,price_rupees,price_unit,moq,moq_unit,hsn,language,image_files,image_urls,attr:gsm (GSM),attr:grade (Grade)";
const line = (sku: string, extra: Partial<Record<string, string>> = {}) =>
  [sku, extra.title ?? `Pipe ${sku}`, slug, extra.description ?? "Mild steel ERW pipe to IS 1239", extra.price ?? "84.50", "kg", "5", "kg", "7306", "en", extra.files ?? "", "", extra.gsm ?? "3", extra.grade ?? "IS 1239"].join(",");
const file = (...lines: string[]) => new Uint8Array(Buffer.from([HDR, ...lines].join("\n")));
const up = (bytes: Uint8Array, name: string) => ({ bytes, filename: name });
const OPTS = { mode: "upsert" as const, submitForReview: false };

async function importAll(a: Awaited<ReturnType<typeof actor>>, bytes: Uint8Array, name: string, opts: Partial<typeof OPTS> & { skipInvalid?: boolean } = {}) {
  const v = await bulk.createImportJob(a, up(bytes, name), { ...OPTS, ...opts });
  expect(v.status).toBe("validated");
  if (v.totalRows - v.errorCount === 0) return v;
  await bulk.confirmImportJob(a, v.id, { skipInvalid: opts.skipInvalid });
  await bulk.runImportJob(v.id);
  return bulk.getJob(a, v.id);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bulk-test-"));
  setMediaStore(new LocalMediaStore(dir));
  bulk.setBulkStore(store);
  setJobQueue(queue);
  const [c] = await catalogue.upsertCategories([
    { slug, name: `Bulk Pipes ${tag}`, attributeSchema: { fields: [{ key: "gsm", label: "GSM", type: "number" }, { key: "grade", label: "Grade", type: "text" }] } },
  ]);
  catId = c!.id;
});

afterAll(async () => {
  const ids = (await prisma.listing.findMany({ where: { sellerBusinessId: { in: bizIds } }, select: { id: true } })).map((l) => l.id);
  const imgs = (await prisma.listingImage.findMany({ where: { listingId: { in: ids } }, select: { id: true } })).map((i) => i.id);
  const jobs = (await prisma.bulkJob.findMany({ where: { sellerBusinessId: { in: bizIds } }, select: { id: true } })).map((j) => j.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [...ids, ...imgs, ...jobs] } } }).catch(() => {});
  await prisma.listingImage.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.bulkJob.deleteMany({ where: { sellerBusinessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
  setMediaStore(undefined);
  bulk.setBulkStore(undefined);
  setJobQueue(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("catalogue sku support", () => {
  it("stores sku, rejects duplicates per seller, allows the same sku for another seller", async () => {
    const [a, b] = [await actor(), await actor()];
    const input = { categoryId: catId, title: "SKU test", description: "d", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageUrls: [], sku: "SK-1" };
    const l = await catalogue.createListing(a.businessId, input);
    expect(l.sku).toBe("SK-1");
    await expect(catalogue.createListing(a.businessId, input)).rejects.toMatchObject({ code: "conflict" });
    await expect(catalogue.createListing(a.businessId, { ...input, sku: "bad sku" })).rejects.toMatchObject({ code: "validation" });
    expect((await catalogue.createListing(b.businessId, input)).sku).toBe("SK-1");
    expect((await catalogue.findSellerListingBySku(a.businessId, "SK-1"))?.id).toBe(l.id);
    expect(await catalogue.findSellerListingBySku(a.businessId, "nope")).toBeNull();
    const other = await catalogue.createListing(a.businessId, { ...input, sku: "SK-2" });
    await expect(catalogue.updateListing(a.businessId, other.id, { sku: "SK-1" })).rejects.toMatchObject({ code: "conflict" });
    expect((await catalogue.updateListing(a.businessId, other.id, { sku: "SK-3" })).sku).toBe("SK-3");
    expect([...(await catalogue.findSellerListingsBySkus(a.businessId, ["SK-1", "SK-3", "x"])).keys()].sort()).toEqual(["SK-1", "SK-3"]);
  });
});

describe("import lifecycle", () => {
  it("validates, confirms, imports in the working copy and emits BulkJobFinished", async () => {
    const a = await actor();
    const job = await bulk.createImportJob(a, up(file(line("P-1"), line("P-2", { price: "12" })), "pipes.csv"), OPTS);
    expect(job).toMatchObject({ status: "validated", totalRows: 2, errorCount: 0, hasSource: true });
    expect(store.files.get(`bulk/${job.id}/source.csv`)).toBeTruthy();
    await bulk.confirmImportJob(a, job.id);
    expect((await bulk.getJob(a, job.id)).status).toBe("queued");
    expect(await queue.consume("bulk.import", "bulk", "t", async (m) => bulk.runImportJob(m.payload.jobId, m))).toBe(1);
    const done = await bulk.getJob(a, job.id);
    expect(done).toMatchObject({ status: "completed", createdCount: 2, updatedCount: 0, errorCount: 0, processedRows: 2 });
    const l = await catalogue.findSellerListingBySku(a.businessId, "P-1");
    expect(l).toMatchObject({ title: "Pipe P-1", pricePaise: 8450, priceUnit: "kg", moq: 5, hsn: "7306", status: "draft", attributes: { gsm: 3, grade: "IS 1239" } });
    expect(await prisma.domainEvent.findFirst({ where: { type: "BulkJobFinished", aggregateId: job.id } })).toBeTruthy();
  });

  it("upsert by SKU is idempotent: same file twice updates in place, never duplicates", async () => {
    const a = await actor();
    await importAll(a, file(line("U-1"), line("U-2")), "a.csv");
    const before = await prisma.listing.findMany({ where: { sellerBusinessId: a.businessId }, select: { id: true } });
    const j2 = await importAll(a, file(line("U-1", { title: "Renamed U-1", price: "" }), line("U-2")), "a.csv");
    expect(j2).toMatchObject({ status: "completed", createdCount: 0, updatedCount: 2 });
    const after = await prisma.listing.findMany({ where: { sellerBusinessId: a.businessId }, select: { id: true } });
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
    const u1 = await catalogue.findSellerListingBySku(a.businessId, "U-1");
    expect(u1).toMatchObject({ title: "Renamed U-1", pricePaise: 8450 }); // blank price cell = unchanged
    // running a finished job again does nothing
    await bulk.runImportJob(j2.id);
    expect((await bulk.getJob(a, j2.id)).updatedCount).toBe(2);
  });

  it("create mode reports existing SKUs; confirm needs an explicit skipInvalid; error report lists only bad rows", async () => {
    const a = await actor();
    await importAll(a, file(line("C-1")), "a.csv");
    const v = await bulk.createImportJob(a, up(file(line("C-1"), line("C-2"), line("C-3", { price: "abc" })), "b.csv"), { mode: "create", submitForReview: false });
    expect(v).toMatchObject({ status: "validated", totalRows: 3, errorCount: 2 });
    expect(v.sampleErrors.map((e) => [e.row, e.column])).toEqual([[2, "sku"], [4, "price_rupees"]]);
    await expect(bulk.confirmImportJob(a, v.id)).rejects.toMatchObject({ code: "validation" });
    const dl = await bulk.getDownload(a, v.id, "errors");
    expect(dl.filename).toBe("b-errors.csv");
    expect(strFromU8(dl.bytes!)).toContain("already exists");
    await bulk.confirmImportJob(a, v.id, { skipInvalid: true });
    await bulk.runImportJob(v.id);
    const done = await bulk.getJob(a, v.id);
    expect(done).toMatchObject({ status: "completed_with_errors", createdCount: 1, errorCount: 2, processedRows: 3 });
    expect(await catalogue.findSellerListingBySku(a.businessId, "C-2")).toBeTruthy();
    expect(await catalogue.findSellerListingBySku(a.businessId, "C-3")).toBeNull();
  });

  it("submitForReview sends each listing to review (never live) and reports rows that cannot be submitted", async () => {
    const a = await actor();
    const j = await importAll(a, file(line("R-1"), line("R-2", { description: "" })), "r.csv", { submitForReview: true, skipInvalid: true });
    expect(j.status).toBe("completed_with_errors");
    expect(j.createdCount).toBe(1);
    const l = await catalogue.findSellerListingBySku(a.businessId, "R-1");
    const versions = await prisma.listingVersion.findMany({ where: { listingId: l!.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.status).toBe("in_review");
    expect(versions[0]!.changeNote).toBe("Bulk import");
    expect(l!.status).toBe("draft");
  });

  it("resumes from the processed-row checkpoint instead of redoing rows", async () => {
    const a = await actor();
    const v = await bulk.createImportJob(a, up(file(line("K-1"), line("K-2")), "k.csv"), { ...OPTS, mode: "create" });
    await bulk.confirmImportJob(a, v.id);
    await redis.hset(`bulk:ckpt:${v.id}`, "2", JSON.stringify({ o: "c", images: 0, errs: [] })); // row 2 (K-1) done by an earlier attempt
    await bulk.runImportJob(v.id);
    expect(await catalogue.findSellerListingBySku(a.businessId, "K-1")).toBeNull();
    expect(await catalogue.findSellerListingBySku(a.businessId, "K-2")).toBeTruthy();
    expect(await bulk.getJob(a, v.id)).toMatchObject({ status: "completed", createdCount: 2, processedRows: 2 });
  });

  it("only one active import per seller; cancel stops it; a new upload supersedes an unconfirmed one", async () => {
    const a = await actor();
    const v1 = await bulk.createImportJob(a, up(file(line("A-1")), "1.csv"), OPTS);
    const v2 = await bulk.createImportJob(a, up(file(line("A-2")), "2.csv"), OPTS);
    expect((await bulk.getJob(a, v1.id)).status).toBe("cancelled");
    await bulk.confirmImportJob(a, v2.id);
    await expect(bulk.createImportJob(a, up(file(line("A-3")), "3.csv"), OPTS)).rejects.toMatchObject({ code: "conflict" });
    await bulk.cancelJob(a, v2.id);
    await bulk.runImportJob(v2.id); // a worker delivering a cancelled job does nothing
    expect(await catalogue.findSellerListingBySku(a.businessId, "A-2")).toBeNull();
    await expect(bulk.cancelJob(a, v2.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(bulk.confirmImportJob(a, v2.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("limits imports to 10 per hour", async () => {
    const a = await actor();
    for (let i = 0; i < 10; i++) await bulk.createImportJob(a, up(file(line(`L-${i}`)), "l.csv"), OPTS);
    await expect(bulk.createImportJob(a, up(file(line("L-x")), "l.csv"), OPTS)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("sends 500+ row files to the bulk.validate queue", async () => {
    const a = await actor();
    const rows = Array.from({ length: 500 }, (_, i) => line(`Q-${i}`));
    const v = await bulk.createImportJob(a, up(file(...rows), "big.csv"), OPTS);
    expect(v.status).toBe("uploaded");
    expect(await queue.consume("bulk.validate", "bulk", "t", async (m) => bulk.validateImportJob(m.payload.jobId))).toBe(1);
    expect(await bulk.getJob(a, v.id)).toMatchObject({ status: "validated", totalRows: 500, errorCount: 0 });
  });

  it("file-level problems are rejected up front without creating a job", async () => {
    const a = await actor();
    await expect(bulk.createImportJob(a, up(new Uint8Array(Buffer.from("x,y\n1,2")), "bad.csv"), OPTS)).rejects.toMatchObject({ code: "validation" });
    await expect(bulk.createImportJob(a, up(file(line("X")), "x.csv"), { mode: undefined as never, submitForReview: false })).rejects.toMatchObject({ code: "validation" });
    expect(await bulk.listJobs(a)).toEqual([]);
  });

  it("zip: attaches images (into the approval flow), and re-import is idempotent", async () => {
    const a = await actor();
    const z = zip({ "products.csv": [HDR, line("Z-1", { files: "one.png" })].join("\n"), "images/one.png": png() });
    const j = await importAll(a, z, "kit.zip");
    expect(j).toMatchObject({ status: "completed", createdCount: 1, imageCount: 1, format: "zip" });
    const l = await catalogue.findSellerListingBySku(a.businessId, "Z-1");
    const imgs = await catalogue.listSellerListingImages(a.businessId, l!.id);
    expect(imgs).toHaveLength(1);
    expect(["pending", "flagged"]).toContain(imgs[0]!.status);
    const j2 = await importAll(a, z, "kit.zip");
    expect(j2).toMatchObject({ status: "completed", updatedCount: 1, imageCount: 0 });
    expect(await catalogue.listSellerListingImages(a.businessId, l!.id)).toHaveLength(1);
  });

  it("zip: a missing referenced image is a validation error, not a silent skip", async () => {
    const a = await actor();
    const z = zip({ "products.csv": [HDR, line("Z-9", { files: "ghost.png" })].join("\n") });
    const v = await bulk.createImportJob(a, up(z, "kit.zip"), OPTS);
    expect(v).toMatchObject({ status: "validated", errorCount: 1 });
    expect(v.sampleErrors[0]!.message).toContain("ghost.png");
  });
});

describe("downloads, ownership and retention", () => {
  it("is seller-scoped", async () => {
    const [a, b] = [await actor(), await actor()];
    const v = await bulk.createImportJob(a, up(file(line("O-1")), "own.csv"), OPTS);
    await expect(bulk.getJob(b, v.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(bulk.getDownload(b, v.id, "source")).rejects.toMatchObject({ code: "forbidden" });
    await expect(bulk.confirmImportJob(b, v.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(bulk.cancelJob(b, v.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(bulk.getJob(a, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    expect(await bulk.listJobs(b)).toEqual([]);
    expect((await bulk.getDownload(a, v.id, "source")).filename).toBe("own.csv");
    await expect(bulk.getDownload(a, v.id, "result")).rejects.toMatchObject({ code: "not_found" });
  });

  it("purges files after retention and marks the job expired", async () => {
    const a = await actor();
    const v = await bulk.createImportJob(a, up(file(line("E-1"), line("E-x", { price: "bad" })), "e.csv"), OPTS);
    expect(v.hasErrorReport).toBe(true);
    await prisma.bulkJob.update({ where: { id: v.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await bulk.purgeExpiredJobs()).toBeGreaterThanOrEqual(1);
    const after = await bulk.getJob(a, v.id);
    expect(after).toMatchObject({ status: "expired", hasSource: false, hasErrorReport: false });
    expect(store.files.has(`bulk/${v.id}/source.csv`)).toBe(false);
    await expect(bulk.getDownload(a, v.id, "source")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("export + round trip", () => {
  it("exports in the import layout; re-importing the export changes nothing (xlsx, csv, zip with images)", async () => {
    const a = await actor();
    const z = zip({ "products.csv": [HDR, line("RT-1", { files: "a.png", gsm: "250", price: "1250.50" }), line("RT-2", { price: "" })].join("\n"), "images/a.png": png() });
    await importAll(a, z, "kit.zip");
    // a listing created by hand without a SKU is exported with a generated one
    const manual = await catalogue.createListing(a.businessId, { categoryId: catId, title: "Manual pipe", description: "made in the editor", attributes: {}, pricePaise: 100, priceUnit: "kg", moq: null, moqUnit: null, hsn: null, language: "hi", imageUrls: [] });
    const before = (await catalogue.listSellerListings(a.businessId)).map((l) => ({ ...l, updatedAt: "" })).sort((x, y) => x.title.localeCompare(y.title));

    for (const format of ["xlsx", "csv"] as const) {
      const out = await bulk.buildExport(a.businessId, { format, includeImages: false });
      expect(out.rows).toBe(3);
      const parsed = await bulk.parseImportFile({ bytes: out.bytes, filename: `export.${out.ext}` });
      expect(parsed.keys.slice(0, 12)).toEqual(["sku", "title", "category", "description", "price_rupees", "price_unit", "moq", "moq_unit", "hsn", "language", "image_files", "image_urls"]);
      const existing = await catalogue.findSellerListingsBySkus(a.businessId, parsed.rows.map((r) => r.cells.sku!));
      const res = bulk.validateRows(parsed.rows, { categories: await catalogue.listCategories(), zipImages: [], isZip: false, mode: "upsert", submitForReview: false, existing });
      expect(res.errors).toEqual([]);
      expect(res.warnings).toEqual([]);
      const rt1 = res.valid.find((r) => r.sku === "RT-1")!;
      expect(rt1).toMatchObject({ title: "Pipe RT-1", pricePaise: 125050, attributes: { gsm: 250, grade: "IS 1239" } });
    }

    const zipOut = await bulk.buildExport(a.businessId, { format: "csv", includeImages: true });
    expect(zipOut.ext).toBe("zip");
    const files = unzipSync(zipOut.bytes);
    expect(Object.keys(files).sort()).toEqual(["images/RT-1-1.png", "products.csv"]);
    // ... and that export zip is itself a valid import: second import updates 3 rows, uploads 0 new images
    const j = await importAll(a, zipOut.bytes, "export.zip");
    expect(j).toMatchObject({ status: "completed", createdCount: 0, updatedCount: 3, imageCount: 0, errorCount: 0 });
    const after = (await catalogue.listSellerListings(a.businessId)).map((l) => ({ ...l, updatedAt: "" })).sort((x, y) => x.title.localeCompare(y.title));
    const strip = (l: (typeof before)[number]) => ({ ...l, sku: l.sku ?? null });
    expect(after.map(strip)).toEqual(before.map(strip).map((l) => (l.id === manual.id ? { ...l, sku: after.find((x) => x.id === manual.id)!.sku } : l)));
    expect((await catalogue.findSellerListingBySku(a.businessId, `L-${manual.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`))?.id).toBe(manual.id);
  });

  it("export job: queued -> built by the worker -> downloadable, seller scoped, event emitted", async () => {
    const a = await actor();
    await importAll(a, file(line("X-1")), "x.csv");
    const j = await bulk.createExportJob(a, { format: "xlsx", includeImages: false });
    expect(j.status).toBe("queued");
    await expect(bulk.createExportJob(a, { format: "xlsx" })).rejects.toMatchObject({ code: "conflict" });
    expect(await queue.consume("bulk.export", "bulk", "t", async (m) => bulk.runExportJob(m.payload.jobId, m))).toBe(1);
    const done = await bulk.getJob(a, j.id);
    expect(done).toMatchObject({ status: "completed", hasResult: true, totalRows: 1, format: "xlsx" });
    const dl = await bulk.getDownload(a, j.id, "result");
    expect(dl.filename).toMatch(/^products-export-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(dl.bytes!.length).toBeGreaterThan(1000);
    expect(await prisma.domainEvent.findFirst({ where: { type: "BulkJobFinished", aggregateId: j.id } })).toBeTruthy();
  });
});
