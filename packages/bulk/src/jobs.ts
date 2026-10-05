// Bulk job lifecycle (ADR-006/007): upload -> dry-run validation -> seller confirms -> queued batch import -> report.
// Everything goes through @cnote/catalogue's public functions, so imported content is a WORKING COPY that reaches
// buyers only via submitListingVersion -> review -> publisher, and images only after staff approval.
import { randomUUID } from "node:crypto";
import * as catalogue from "@cnote/catalogue";
import { DomainError, emit, getJobQueue, rateLimit, redis } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { columnsFor } from "./columns";
import { buildErrorReport } from "./report";
import { detectFormat, parseImportFile, readZipEntries, type ParsedImport } from "./parse";
import { addProductsSheet, newWorkbook, toCsv, workbookBuffer, type Cell } from "./sheets";
import { getBulkStore } from "./store";
import { LIMITS, type BulkActor, type BulkJobStatusName, type BulkJobView, type FileFormat, type ImportOptions, type RowError } from "./types";
import { validateRows, type ImportRow, type ValidationResult } from "./validate";
import { zipSync } from "fflate";

type JobRow = Prisma.BulkJobGetPayload<object>;

const DAY_MS = 24 * 3600 * 1000;
const ACTIVE: BulkJobStatusName[] = ["uploaded", "validating", "validated", "queued", "processing"];
const BUSY: BulkJobStatusName[] = ["validating", "queued", "processing"];
const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};
/** bulk uploads are throttled separately from one-at-a-time uploads; every image is still approved by staff */
const BULK_IMAGE_UPLOADS_PER_HOUR = 5_000;

const expiry = () => new Date(Date.now() + LIMITS.retentionDays * DAY_MS);
const errMsg = (e: unknown) => (e instanceof DomainError ? e.message : "Unexpected error");
const isActive = (s: string) => (ACTIVE as string[]).includes(s);

type StoredOptions = Partial<ImportOptions> & { includeImages?: boolean; exportFormat?: "csv" | "xlsx"; warnings?: string[] };

export function toJobView(j: JobRow): BulkJobView {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    format: j.format,
    originalName: j.originalName,
    options: (j.options ?? {}) as StoredOptions,
    totalRows: j.totalRows,
    processedRows: j.processedRows,
    createdCount: j.createdCount,
    updatedCount: j.updatedCount,
    errorCount: j.errorCount,
    imageCount: j.imageCount,
    sampleErrors: Array.isArray(j.sampleErrors) ? (j.sampleErrors as unknown as RowError[]) : [],
    lastError: j.lastError,
    hasSource: !!j.sourceKey,
    hasResult: !!j.resultKey,
    hasErrorReport: !!j.errorReportKey,
    active: isActive(j.status) && j.status !== "validated" && j.status !== "uploaded",
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    expiresAt: j.expiresAt?.toISOString() ?? null,
  };
}

async function loadOwned(actor: BulkActor, jobId: string): Promise<JobRow> {
  const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId);
  const job = ok ? await prisma.bulkJob.findUnique({ where: { id: jobId } }) : null;
  if (!job) throw new DomainError("not_found", "Job not found", undefined, "bulk.jobNotFound");
  if (job.sellerBusinessId !== actor.businessId) throw new DomainError("forbidden", "Not your job", undefined, "bulk.notJob");
  return job;
}

const safeName = (n: string) => n.replace(/[\\/\0]/g, "_").slice(0, 200) || "upload";

export async function getJob(actor: BulkActor, jobId: string): Promise<BulkJobView> {
  return toJobView(await loadOwned(actor, jobId));
}

export async function listJobs(actor: BulkActor, opts: { kind?: "import" | "export"; limit?: number } = {}): Promise<BulkJobView[]> {
  const rows = await prisma.bulkJob.findMany({
    where: { sellerBusinessId: actor.businessId, ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(100, opts.limit ?? 20)),
  });
  return rows.map(toJobView);
}

async function finishEvent(tx: Prisma.TransactionClient, j: Pick<JobRow, "id" | "sellerBusinessId" | "createdBy" | "kind">, status: string, c: { created: number; updated: number; errors: number }) {
  await emit(tx, "BulkJobFinished", { type: "bulk_job", id: j.id }, { jobId: j.id, sellerBusinessId: j.sellerBusinessId, createdBy: j.createdBy, kind: j.kind, status, ...c });
}

// ---------------------------------------------------------------------------------------------
// import: upload + validate

function parseOptions(o: Partial<ImportOptions>): ImportOptions {
  if (o.mode !== "create" && o.mode !== "upsert") throw new DomainError("validation", 'Choose "create new" or "update by SKU"', undefined, "bulk.chooseCreateNewUpdateBy");
  return { mode: o.mode, submitForReview: !!o.submitForReview };
}

export async function createImportJob(actor: BulkActor, upload: { bytes: Uint8Array; filename: string }, options: Partial<ImportOptions>): Promise<BulkJobView> {
  const opts = parseOptions(options);
  const format = detectFormat(upload.bytes, upload.filename);
  const max = format === "zip" ? LIMITS.maxZipCompressedBytes : LIMITS.maxSheetBytes;
  if (upload.bytes.length > max) throw new DomainError("validation", `File is larger than ${max / 1024 / 1024} MB`, undefined, "bulk.fileLargerThanMb", { mb: max / 1024 / 1024 });

  const busy = await prisma.bulkJob.findFirst({ where: { sellerBusinessId: actor.businessId, kind: "import", status: { in: BUSY } }, select: { id: true } });
  if (busy) throw new DomainError("conflict", "Another import is still running. Wait for it to finish or cancel it first", undefined, "bulk.anotherImportStillRunningWait");
  if (!(await rateLimit(`bulk-import:${actor.businessId}`, LIMITS.importsPerHour, 3600))) {
    throw new DomainError("rate_limited", `You can start ${LIMITS.importsPerHour} imports per hour. Please try again later`, undefined, "bulk.startImportsPerHourTry", { importsPerHour: LIMITS.importsPerHour });
  }

  // A file-level problem (bad zip, missing columns, too many rows) is reported straight back: no job, nothing stored.
  const parsed = await parseImportFile({ bytes: upload.bytes, filename: upload.filename });

  // An earlier upload that was never confirmed is superseded.
  await prisma.bulkJob.updateMany({ where: { sellerBusinessId: actor.businessId, kind: "import", status: { in: ["uploaded", "validated"] } }, data: { status: "cancelled", finishedAt: new Date() } });

  const id = randomUUID();
  const key = `bulk/${id}/source.${format}`;
  await getBulkStore().put(key, upload.bytes, CONTENT_TYPES[format]!);
  try {
    await prisma.bulkJob.create({
      data: { id, sellerBusinessId: actor.businessId, createdBy: actor.personId, kind: "import", status: "uploaded", format, originalName: safeName(upload.filename), sourceKey: key, options: opts as unknown as Prisma.InputJsonValue, expiresAt: expiry() },
    });
  } catch (e) {
    await getBulkStore().delete(key).catch(() => undefined);
    throw e;
  }
  if (parsed.rows.length < LIMITS.syncValidateRows) await validateImportJob(id, parsed);
  else await getJobQueue().enqueue("bulk.validate", { jobId: id }, { dedupeKey: `validate:${id}`, maxAttempts: 3 });
  return toJobView(await prisma.bulkJob.findUniqueOrThrow({ where: { id } }));
}

async function validateAgainstCatalogue(job: Pick<JobRow, "sellerBusinessId" | "options">, parsed: ParsedImport, rows = parsed.rows): Promise<ValidationResult> {
  const o = job.options as unknown as ImportOptions;
  const [categories, existing] = await Promise.all([
    catalogue.listCategories(),
    catalogue.findSellerListingsBySkus(job.sellerBusinessId, [...new Set(rows.map((r) => r.cells.sku ?? "").filter(Boolean))]),
  ]);
  // variant rows of an existing listing without a product row in the file need that listing's category (its variant axes)
  const productSkus = new Set(rows.filter((r) => !r.cells.variant_sku).map((r) => r.cells.sku ?? ""));
  const existingCategoryBySku = new Map<string, string>();
  for (const sku of new Set(rows.filter((r) => r.cells.variant_sku).map((r) => r.cells.sku ?? ""))) {
    if (productSkus.has(sku) || !existing.has(sku)) continue;
    const l = await catalogue.findSellerListingBySku(job.sellerBusinessId, sku);
    if (l) existingCategoryBySku.set(sku, l.category.id);
  }
  return validateRows(rows, {
    categories, existing, existingCategoryBySku, mode: o.mode, submitForReview: !!o.submitForReview, isZip: parsed.format === "zip", zipImages: parsed.images.map((i) => i.path), fileKeys: parsed.keys,
  });
}

/** Dry run. Idempotent: safe to re-run after a crash while `uploaded`/`validating`. */
export async function validateImportJob(jobId: string, parsedIn?: ParsedImport): Promise<void> {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job || job.kind !== "import" || !["uploaded", "validating"].includes(job.status)) return;
  await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "validating", startedAt: job.startedAt ?? new Date() } });
  const store = getBulkStore();
  try {
    let parsed = parsedIn;
    if (!parsed) {
      const bytes = job.sourceKey ? await store.get(job.sourceKey) : null;
      if (!bytes) throw new DomainError("not_found", "The uploaded file is no longer available", undefined, "bulk.uploadedFileNoLongerAvailable");
      parsed = await parseImportFile({ bytes, filename: job.originalName ?? `source.${job.format}` });
    }
    const res = await validateAgainstCatalogue(job, parsed);
    let errorReportKey: string | null = null;
    if (res.errors.length) {
      const report = await buildErrorReport({ headers: parsed.headers, keys: parsed.keys, rows: parsed.rows, errors: res.errors, format: parsed.format });
      errorReportKey = `bulk/${jobId}/errors.${report.ext}`;
      await store.put(errorReportKey, report.bytes, CONTENT_TYPES[report.ext]!);
    }
    const stored = { ...(job.options as object), warnings: [...res.warnings] };
    await prisma.bulkJob.update({
      where: { id: jobId },
      data: {
        status: "validated",
        totalRows: parsed.rows.length,
        errorCount: res.invalidRows.size,
        sampleErrors: res.errors.slice(0, LIMITS.sampleErrors) as unknown as Prisma.InputJsonValue,
        errorReportKey,
        options: stored as unknown as Prisma.InputJsonValue,
        lastError: null,
      },
    });
  } catch (e) {
    if (e instanceof DomainError) {
      await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "failed", lastError: e.message, finishedAt: new Date() } });
      return; // the seller fixes the file; retrying would not help
    }
    throw e;
  }
}

export async function confirmImportJob(actor: BulkActor, jobId: string, opts: { skipInvalid?: boolean } = {}): Promise<BulkJobView> {
  const job = await loadOwned(actor, jobId);
  if (job.kind !== "import") throw new DomainError("conflict", "Not an import job", undefined, "bulk.notImportJob");
  if (job.status !== "validated") throw new DomainError("conflict", job.status === "queued" || job.status === "processing" ? "This import is already running" : "This import cannot be confirmed in its current state");
  const validRows = job.totalRows - job.errorCount;
  if (validRows <= 0) throw new DomainError("validation", "There are no valid rows to import. Fix the errors and upload again", undefined, "bulk.noValidRowsImportFix");
  if (job.errorCount > 0 && !opts.skipInvalid) throw new DomainError("validation", `${job.errorCount} row(s) have errors. Fix them, or confirm to import only the ${validRows} valid row(s)`, undefined, "bulk.rowSErrorsFixThem", { errorCount: job.errorCount, validRows });
  const busy = await prisma.bulkJob.findFirst({ where: { sellerBusinessId: actor.businessId, kind: "import", status: { in: ["queued", "processing"] } }, select: { id: true } });
  if (busy) throw new DomainError("conflict", "Another import is still running", undefined, "bulk.anotherImportStillRunning");
  const claimed = await prisma.bulkJob.updateMany({
    where: { id: jobId, status: "validated" },
    data: { status: "queued", options: { ...(job.options as object), skipInvalid: !!opts.skipInvalid } as Prisma.InputJsonValue, processedRows: 0, createdCount: 0, updatedCount: 0, imageCount: 0 },
  });
  if (claimed.count !== 1) throw new DomainError("conflict", "This import was already confirmed", undefined, "bulk.importAlreadyConfirmed");
  await getJobQueue().enqueue("bulk.import", { jobId }, { dedupeKey: `import:${jobId}`, maxAttempts: 3 });
  return getJob(actor, jobId);
}

export async function cancelJob(actor: BulkActor, jobId: string): Promise<BulkJobView> {
  const job = await loadOwned(actor, jobId);
  if (!isActive(job.status)) throw new DomainError("conflict", "This job has already finished", undefined, "bulk.jobAlreadyFinished");
  await prisma.bulkJob.updateMany({ where: { id: jobId, status: { in: ACTIVE } }, data: { status: "cancelled", finishedAt: new Date(), expiresAt: expiry() } });
  return getJob(actor, jobId);
}

// ---------------------------------------------------------------------------------------------
// import: processing

interface Outcome {
  o: "c" | "u" | "e";
  images: number;
  errs: RowError[];
}

const ckptKey = (jobId: string) => `bulk:ckpt:${jobId}`;

async function loadCheckpoint(jobId: string): Promise<Map<number, Outcome>> {
  try {
    const all = await redis.hgetall(ckptKey(jobId));
    return new Map(Object.entries(all).map(([row, v]) => [Number(row), JSON.parse(v) as Outcome]));
  } catch {
    return new Map();
  }
}
async function saveCheckpoint(jobId: string, row: number, o: Outcome): Promise<void> {
  try {
    await redis.hset(ckptKey(jobId), String(row), JSON.stringify(o));
    await redis.expire(ckptKey(jobId), 3 * DAY_MS / 1000);
  } catch {
    /* best effort: every step below is idempotent by SKU / image hash anyway */
  }
}

/** Trade info for the sample columns merged over the listing's existing trade facts; null when the row sets no sample column. */
function sampleTrade(r: ImportRow, existing: catalogue.TradeInfo | undefined): catalogue.TradeInfo | null {
  const touched = [r.sampleAvailable, r.samplePricePaise, r.sampleMaxQty, r.sampleDispatchDays, r.sampleMinBuyerTier].some((x) => x !== undefined);
  if (!touched) return null;
  const t: catalogue.TradeInfo = { ...(existing ?? {}) };
  if (r.sampleAvailable !== undefined) t.sampleAvailable = r.sampleAvailable;
  if (r.samplePricePaise !== undefined) t.samplePricePaise = r.samplePricePaise;
  if (r.sampleMaxQty !== undefined) t.sampleMaxQty = r.sampleMaxQty;
  if (r.sampleDispatchDays !== undefined) t.sampleDispatchDays = r.sampleDispatchDays;
  if (r.sampleMinBuyerTier !== undefined) t.sampleMinBuyerTier = r.sampleMinBuyerTier;
  return t;
}

/**
 * Replaces the listing's variant set with the file's. A variant that already exists (same SKU) keeps its id, its quantity tiers and its image,
 * and any stock cell left blank keeps the stored value; new variants start in stock.
 */
async function applyVariants(bid: string, listingId: string, variants: NonNullable<ImportRow["variants"]>): Promise<void> {
  const current = new Map((await catalogue.listingVariantsForSeller(bid, listingId)).map((v) => [v.sku, v]));
  await catalogue.setListingVariants(bid, listingId, variants.map((v): catalogue.VariantInput => {
    const old = current.get(v.sku);
    return {
      ...(old ? { id: old.id } : {}),
      sku: v.sku,
      axisValues: v.axisValues,
      pricePaise: v.pricePaise ?? null,
      priceTiers: old?.priceTiers ?? [],
      moq: v.moq ?? null,
      availability: v.availability ?? old?.availability ?? "in_stock",
      availableQty: v.availableQty !== undefined ? v.availableQty : (v.availability === "out_of_stock" ? null : (old?.availableQty ?? null)),
      leadTimeDays: v.leadTimeDays !== undefined ? v.leadTimeDays : (old?.leadTimeDays ?? null),
      imageId: old?.imageId ?? null,
    };
  }));
}

const baseName = (p: string) => p.split("/").pop() ?? p;

async function processRow(job: JobRow, opts: ImportOptions, r: ImportRow, images: Map<string, Uint8Array>, entryOf: Map<string, string>): Promise<Outcome> {
  const bid = job.sellerBusinessId;
  const errs: RowError[] = [];
  let listingId: string;
  let kind: "c" | "u";
  try {
    const ex = await catalogue.findSellerListingBySku(bid, r.sku);
    if (r.variantsOnly) {
      if (!ex) throw new DomainError("not_found", `SKU "${r.sku}" does not exist`, undefined, "bulk.skuNotFound", { sku: r.sku });
      listingId = ex.id;
      kind = "u";
    } else if (ex) {
      if (opts.mode === "create") throw new DomainError("conflict", `SKU "${r.sku}" already exists`, undefined, "bulk.skuAlreadyExists", { sku: r.sku });
      const patch: Partial<catalogue.ListingInput> = { title: r.title, categoryId: r.categoryId, attributes: { ...ex.attributes, ...r.attributes } };
      if (r.description !== undefined) patch.description = r.description;
      if (r.pricePaise !== undefined) patch.pricePaise = r.pricePaise;
      if (r.priceUnit !== undefined) patch.priceUnit = r.priceUnit;
      if (r.moq !== undefined) patch.moq = r.moq;
      if (r.moqUnit !== undefined) patch.moqUnit = r.moqUnit;
      if (r.hsn !== undefined) patch.hsn = r.hsn;
      if (r.language !== undefined) patch.language = r.language;
      if (r.shipping) patch.trade = { ...ex.trade, ...r.shipping }; // updateListing replaces the whole trade block, so keep the rest
      if (r.imageUrls.length) patch.imageUrls = r.imageUrls;
      const trade = sampleTrade(r, patch.trade ?? ex.trade);
      if (trade) patch.trade = trade;
      listingId = (await catalogue.updateListing(bid, ex.id, patch)).id;
      // stock is operational: it goes through the fast path (no review) and reaches a live listing at once
      if (r.availability !== undefined || r.availableQty !== undefined || r.leadTimeDays !== undefined) {
        await catalogue.updateListingStock(bid, ex.id, {
          ...(r.availability !== undefined ? { availability: r.availability } : {}),
          ...(r.availableQty !== undefined ? { availableQty: r.availableQty } : {}),
          ...(r.leadTimeDays !== undefined ? { leadTimeDays: r.leadTimeDays } : {}),
        });
      }
      kind = "u";
    } else {
      const created = await catalogue.createListing(bid, {
        sku: r.sku, categoryId: r.categoryId, title: r.title, description: r.description ?? "", attributes: r.attributes, pricePaise: r.pricePaise ?? null, priceUnit: r.priceUnit ?? null,
        moq: r.moq ?? null, moqUnit: r.moqUnit ?? null, hsn: r.hsn ?? null, language: r.language ?? "en", imageUrls: r.imageUrls,
        ...(r.availability !== undefined ? { availability: r.availability } : {}),
        ...(r.availableQty !== undefined ? { availableQty: r.availableQty } : {}),
        ...(r.shipping || r.leadTimeDays !== undefined || sampleTrade(r, undefined)
          ? { trade: { ...(r.shipping ?? {}), ...(r.leadTimeDays !== undefined ? { leadTimeDays: r.leadTimeDays } : {}), ...(sampleTrade(r, undefined) ?? {}) } }
          : {}),
      });
      listingId = created.id;
      kind = "c";
    }
  } catch (e) {
    if (!(e instanceof DomainError)) console.error("[bulk] row failed", job.id, r.row, e);
    return { o: "e", images: 0, errs: [{ row: r.row, column: "", message: errMsg(e) }] };
  }

  if (r.variants) {
    try {
      await applyVariants(bid, listingId, r.variants);
    } catch (e) {
      const row = r.variants[0]?.row ?? r.row;
      errs.push({ row, column: "", message: `Variants not saved: ${errMsg(e)}` });
    }
  }

  let imageCount = 0;
  for (const p of r.imageFiles) {
    const bytes = images.get(entryOf.get(p) ?? "");
    if (!bytes) {
      errs.push({ row: r.row, column: "image_files", message: `${baseName(p)}: file could not be read from the ZIP` });
      continue;
    }
    try {
      await catalogue.uploadListingImage(bid, listingId, { bytes, filename: baseName(p) }, { rateLimitPerHour: BULK_IMAGE_UPLOADS_PER_HOUR });
      imageCount++;
    } catch (e) {
      if (e instanceof DomainError && e.code === "conflict" && /already uploaded/i.test(e.message)) continue; // idempotent retry / same photo re-imported
      errs.push({ row: r.row, column: "image_files", message: `${baseName(p)}: ${errMsg(e)}` });
    }
  }

  if (opts.submitForReview) {
    try {
      await catalogue.submitListingVersion(bid, listingId, { changeNote: "Bulk import", createdBy: job.createdBy });
    } catch (e) {
      const nothingNew = e instanceof DomainError && e.code === "conflict" && /nothing has changed/i.test(e.message);
      if (!nothingNew) errs.push({ row: r.row, column: "", message: `Saved as draft but could not be submitted for review: ${errMsg(e)}` });
    }
  }
  return { o: errs.length ? (kind === "c" ? "c" : "u") : kind, images: imageCount, errs };
}

function tally(outcomes: Map<number, Outcome>) {
  let created = 0, updated = 0, images = 0, errRows = 0;
  for (const o of outcomes.values()) {
    if (o.o === "c") created++;
    if (o.o === "u") updated++;
    images += o.images;
    if (o.errs.length) errRows++;
  }
  return { created, updated, images, errRows };
}

/** Queue handler body. Resumable: rows already in the Redis checkpoint are skipped; every row step is idempotent. */
export async function runImportJob(jobId: string, attempt: { attempt: number; maxAttempts: number } = { attempt: 1, maxAttempts: 1 }): Promise<void> {
  const token = randomUUID();
  const lockKey = `bulk:lock:${jobId}`;
  let locked = false;
  try {
    locked = (await redis.set(lockKey, token, "EX", 600, "NX")) === "OK";
  } catch {
    locked = true; // no Redis: single-consumer best effort
  }
  if (!locked) return;
  try {
    await importLocked(jobId, lockKey);
  } catch (e) {
    console.error("[bulk] import failed", jobId, e);
    if (attempt.attempt >= attempt.maxAttempts) {
      const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
      if (job && (job.status === "queued" || job.status === "processing")) {
        await prisma.$transaction(async (tx) => {
          await tx.bulkJob.update({ where: { id: jobId }, data: { status: "failed", lastError: errMsg(e), finishedAt: new Date(), expiresAt: expiry() } });
          await finishEvent(tx, job, "failed", { created: job.createdCount, updated: job.updatedCount, errors: job.errorCount });
        });
        return;
      }
    }
    throw e;
  } finally {
    try {
      if ((await redis.get(lockKey)) === token) await redis.del(lockKey);
    } catch {
      /* lock expires on its own */
    }
  }
}

async function importLocked(jobId: string, lockKey: string): Promise<void> {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job || job.kind !== "import" || !["queued", "processing"].includes(job.status)) return;
  const opts = job.options as unknown as ImportOptions;
  await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "processing", startedAt: job.startedAt ?? new Date() } });

  const store = getBulkStore();
  const bytes = job.sourceKey ? await store.get(job.sourceKey) : null;
  if (!bytes) throw new DomainError("not_found", "The uploaded file is no longer available", undefined, "bulk.uploadedFileNoLongerAvailable");
  const parsed = await parseImportFile({ bytes, filename: job.originalName ?? `source.${job.format}` });

  const outcomes = await loadCheckpoint(jobId);
  // rows finished in an earlier attempt must not be re-validated (a created SKU would now look like a duplicate)
  const pending = parsed.rows.filter((r) => !outcomes.has(r.row));
  const res = await validateAgainstCatalogue(job, parsed, pending);
  const entryOf = new Map(parsed.images.map((i) => [i.path, i.entry]));
  const runErrors: RowError[] = [];

  const todo = res.valid.filter((r) => !outcomes.has(r.row));
  for (let i = 0; i < todo.length; i += LIMITS.batchSize) {
    const cur = await prisma.bulkJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!cur || cur.status !== "processing") return; // cancelled
    try {
      await redis.expire(lockKey, 600);
    } catch {
      /* ignore */
    }
    const batch = todo.slice(i, i + LIMITS.batchSize);
    const entries = [...new Set(batch.flatMap((r) => r.imageFiles.map((p) => entryOf.get(p)).filter((x): x is string => !!x)))];
    const images = parsed.format === "zip" ? readZipEntries(bytes, entries) : new Map<string, Uint8Array>();
    for (const r of batch) {
      const o = await processRow(job, opts, r, images, entryOf);
      outcomes.set(r.row, o);
      await saveCheckpoint(jobId, r.row, o);
    }
    const t = tally(outcomes);
    await prisma.bulkJob.updateMany({
      where: { id: jobId, status: "processing" },
      data: { processedRows: res.invalidRows.size + outcomes.size, createdCount: t.created, updatedCount: t.updated, imageCount: t.images, errorCount: res.invalidRows.size + t.errRows },
    });
  }

  // final report: validation errors of this run + per-row runtime errors
  const t = tally(outcomes);
  for (const o of outcomes.values()) runErrors.push(...o.errs);
  const allErrors = [...res.errors, ...runErrors].sort((a, b) => a.row - b.row);
  let errorReportKey: string | null = job.errorReportKey;
  if (allErrors.length) {
    const report = await buildErrorReport({ headers: parsed.headers, keys: parsed.keys, rows: parsed.rows, errors: allErrors, format: parsed.format });
    errorReportKey = `bulk/${jobId}/errors.${report.ext}`;
    await store.put(errorReportKey, report.bytes, CONTENT_TYPES[report.ext]!);
  }
  const errorRows = res.invalidRows.size + t.errRows;
  const status = errorRows > 0 ? "completed_with_errors" : "completed";
  const done = await prisma.$transaction(async (tx) => {
    const u = await tx.bulkJob.updateMany({
      where: { id: jobId, status: "processing" },
      data: {
        status, processedRows: parsed.rows.length, createdCount: t.created, updatedCount: t.updated, imageCount: t.images, errorCount: errorRows,
        sampleErrors: allErrors.slice(0, LIMITS.sampleErrors) as unknown as Prisma.InputJsonValue, errorReportKey, finishedAt: new Date(), expiresAt: expiry(),
      },
    });
    if (u.count === 1) await finishEvent(tx, job, status, { created: t.created, updated: t.updated, errors: errorRows });
    return u.count === 1;
  });
  if (done) await redis.del(ckptKey(jobId)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// export

export async function createExportJob(actor: BulkActor, opts: { format: "xlsx" | "csv"; includeImages?: boolean }): Promise<BulkJobView> {
  if (opts.format !== "xlsx" && opts.format !== "csv") throw new DomainError("validation", "Choose Excel or CSV", undefined, "bulk.chooseExcelCsv");
  const busy = await prisma.bulkJob.findFirst({ where: { sellerBusinessId: actor.businessId, kind: "export", status: { in: ["queued", "processing"] } }, select: { id: true } });
  if (busy) throw new DomainError("conflict", "An export is already being prepared", undefined, "bulk.exportAlreadyBeingPrepared");
  if (!(await rateLimit(`bulk-export:${actor.businessId}`, LIMITS.exportsPerHour, 3600))) throw new DomainError("rate_limited", "Too many exports. Please try again later", undefined, "bulk.tooManyExportsTryAgain");
  const job = await prisma.bulkJob.create({
    data: {
      sellerBusinessId: actor.businessId, createdBy: actor.personId, kind: "export", status: "queued", format: opts.includeImages ? "zip" : opts.format,
      options: { exportFormat: opts.format, includeImages: !!opts.includeImages } as Prisma.InputJsonValue, expiresAt: expiry(),
    },
  });
  await getJobQueue().enqueue("bulk.export", { jobId: job.id }, { dedupeKey: `export:${job.id}`, maxAttempts: 3 });
  return toJobView(job);
}

const generatedSku = (id: string) => `L-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const EXPORT_IMAGE_BYTES_CAP = 400 * 1024 * 1024;

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** Same column layout as the import template, so an export can be edited and imported again. */
export async function buildExport(sellerBusinessId: string, opts: { format: "xlsx" | "csv"; includeImages: boolean; personId?: string }): Promise<{ bytes: Uint8Array; ext: "csv" | "xlsx" | "zip"; rows: number; warnings: string[] }> {
  const warnings: string[] = [];
  const all = (await catalogue.listSellerListings(sellerBusinessId)).filter((l) => l.status !== "archived").reverse();
  const categories = await catalogue.listCategories();
  const usedCats = categories.filter((c) => all.some((l) => l.category.id === c.id));
  const columns = columnsFor(usedCats);
  const extra = ["status (read-only)", "review_state (read-only)", "live_version (read-only)"];
  const headers = [...columns.map((c) => c.header), ...extra];

  const images = new Map<string, { name: string; bytes: Uint8Array }[]>();
  const lines: Cell[][] = [];
  let imageBytes = 0;
  const infos = await pool(all, 8, async (l) => {
    let sku = l.sku ?? null;
    if (!sku) {
      sku = generatedSku(l.id); // gives every listing a stable key so the file can be re-imported
      try {
        await catalogue.updateListing(sellerBusinessId, l.id, { sku });
      } catch {
        sku = null;
      }
    }
    const ov = await catalogue.getVersionOverview(sellerBusinessId, l.id).catch(() => null);
    return { l, sku, ov };
  });
  for (const { l, sku, ov } of infos) {
    const files: { name: string; bytes: Uint8Array }[] = [];
    if (opts.includeImages && sku) {
      const imgs = (await catalogue.listSellerListingImages(sellerBusinessId, l.id)).filter((i) => i.status !== "rejected");
      let n = 0;
      for (const im of imgs) {
        const data = await catalogue.readListingImage(im.id, { kind: "seller", sellerBusinessId });
        if (!data) continue;
        if (imageBytes + data.bytes.length > EXPORT_IMAGE_BYTES_CAP) {
          if (!warnings.some((w) => w.includes("size limit"))) warnings.push("Some images were left out because of the export size limit; export again in smaller parts");
          break;
        }
        imageBytes += data.bytes.length;
        n++;
        files.push({ name: `${sku}-${n}.${data.contentType === "image/jpeg" ? "jpg" : data.contentType.split("/")[1]}`, bytes: data.bytes });
      }
      images.set(sku, files);
    }
    const values: Record<string, Cell> = {
      availability: l.ownAvailability ?? l.availability ?? "in_stock", available_qty: l.availableQty, lead_time_days: l.trade?.leadTimeDays ?? null,
      sku, title: l.title, category: l.category.slug, description: l.description, price_rupees: l.pricePaise === null ? "" : l.pricePaise / 100, price_unit: l.priceUnit, moq: l.moq,
      moq_unit: l.moqUnit, hsn: l.hsn, language: l.language,
      sample_available: l.trade?.sampleAvailable ? "yes" : "", sample_price_rupees: l.trade?.samplePricePaise == null ? "" : l.trade.samplePricePaise / 100,
      sample_max_qty: l.trade?.sampleMaxQty ?? "", sample_dispatch_days: l.trade?.sampleDispatchDays ?? "", sample_min_buyer_tier: l.trade?.sampleMinBuyerTier ?? "",
      image_files: files.map((f) => f.name).join(", "), image_urls: l.imageUrls.filter((u) => u.startsWith("https://")).join(", "),
      unit_weight_g: l.trade?.unitWeightGrams ?? "", unit_length_cm: l.trade?.unitLengthMm ? l.trade.unitLengthMm / 10 : "",
      unit_width_cm: l.trade?.unitWidthMm ? l.trade.unitWidthMm / 10 : "", unit_height_cm: l.trade?.unitHeightMm ? l.trade.unitHeightMm / 10 : "",
    };
    for (const [k, v] of Object.entries(l.attributes)) values[`attr:${k}`] = v;
    lines.push([
      ...columns.map((c) => values[c.key] ?? ""),
      l.status, ov?.pending ? ov.pending.status : ov?.live ? "live" : l.moderationStatus, ov?.live?.version ?? "",
    ]);
    // one row per variant, directly below its product: sku = the product's, variant_sku filled (re-importable as is)
    for (const v of l.variants ?? []) {
      const vv: Record<string, Cell> = {
        sku, variant_sku: v.sku, price_rupees: v.pricePaise === null ? "" : v.pricePaise / 100, moq: v.moq, availability: v.availability, available_qty: v.availableQty, lead_time_days: v.leadTimeDays,
      };
      for (const [k, val] of Object.entries(v.axisValues)) vv[`variant:${k}`] = val;
      lines.push([...columns.map((c) => vv[c.key] ?? ""), "", "", ""]);
    }
  }

  let sheet: Uint8Array;
  let ext: "csv" | "xlsx";
  if (opts.format === "csv") {
    sheet = toCsv(headers, lines);
    ext = "csv";
  } else {
    const wb = newWorkbook();
    const ws = addProductsSheet(wb, { columns, rows: lines.map((l) => l.slice(0, columns.length)), categories, guidance: true });
    // read-only trailing columns
    ws.getRow(1).getCell(columns.length + 1).value = extra[0];
    ws.getRow(1).getCell(columns.length + 2).value = extra[1];
    ws.getRow(1).getCell(columns.length + 3).value = extra[2];
    lines.forEach((l, i) => l.slice(columns.length).forEach((v, j) => void (ws.getRow(i + 2).getCell(columns.length + 1 + j).value = v as string | number)));
    for (let j = 1; j <= 3; j++) {
      const c = ws.getRow(1).getCell(columns.length + j);
      c.font = { bold: true, color: { argb: "FF6B7280" } };
      ws.getColumn(columns.length + j).width = 18;
    }
    sheet = await workbookBuffer(wb);
    ext = "xlsx";
  }
  if (!opts.includeImages) return { bytes: sheet, ext, rows: lines.length, warnings };
  const entries: Record<string, Uint8Array> = { [`products.${ext}`]: sheet };
  for (const files of images.values()) for (const f of files) entries[`images/${f.name}`] = f.bytes;
  return { bytes: zipSync(entries, { level: 0 }), ext: "zip", rows: lines.length, warnings };
}

export async function runExportJob(jobId: string, attempt: { attempt: number; maxAttempts: number } = { attempt: 1, maxAttempts: 1 }): Promise<void> {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job || job.kind !== "export" || !["queued", "processing"].includes(job.status)) return;
  const o = job.options as StoredOptions;
  await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "processing", startedAt: job.startedAt ?? new Date() } });
  try {
    const out = await buildExport(job.sellerBusinessId, { format: o.exportFormat ?? "xlsx", includeImages: !!o.includeImages, personId: job.createdBy });
    const key = `bulk/${jobId}/export.${out.ext}`;
    await getBulkStore().put(key, out.bytes, CONTENT_TYPES[out.ext]!);
    await prisma.$transaction(async (tx) => {
      const u = await tx.bulkJob.updateMany({
        where: { id: jobId, status: "processing" },
        data: { status: "completed", resultKey: key, format: out.ext, totalRows: out.rows, processedRows: out.rows, finishedAt: new Date(), expiresAt: expiry(), options: { ...o, warnings: out.warnings } as Prisma.InputJsonValue },
      });
      if (u.count === 1) await finishEvent(tx, job, "completed", { created: 0, updated: 0, errors: 0 });
    });
  } catch (e) {
    console.error("[bulk] export failed", jobId, e);
    if (attempt.attempt >= attempt.maxAttempts) {
      await prisma.$transaction(async (tx) => {
        await tx.bulkJob.update({ where: { id: jobId }, data: { status: "failed", lastError: errMsg(e), finishedAt: new Date(), expiresAt: expiry() } });
        await finishEvent(tx, job, "failed", { created: 0, updated: 0, errors: 0 });
      });
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// downloads + retention

export interface BulkDownload {
  filename: string;
  contentType: string;
  /** direct signed URL when the storage driver can sign (S3/R2); otherwise null and `bytes` is set */
  url: string | null;
  bytes: Uint8Array | null;
}

export async function getDownload(actor: BulkActor, jobId: string, which: "result" | "errors" | "source", opts: { preferSignedUrl?: boolean } = {}): Promise<BulkDownload> {
  const job = await loadOwned(actor, jobId);
  if (job.status === "expired") throw new DomainError("not_found", `Files are deleted after ${LIMITS.retentionDays} days`, undefined, "bulk.filesDeletedAfterDays", { retentionDays: LIMITS.retentionDays });
  const key = which === "result" ? job.resultKey : which === "errors" ? job.errorReportKey : job.sourceKey;
  if (!key) throw new DomainError("not_found", "Nothing to download for this job", undefined, "bulk.nothingDownloadJob");
  const ext = key.slice(key.lastIndexOf(".") + 1);
  const stamp = (job.finishedAt ?? job.createdAt).toISOString().slice(0, 10);
  const base = (job.originalName ?? "import").replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const filename = which === "result" ? `products-export-${stamp}.${ext}` : which === "errors" ? `${base}-errors.${ext}` : job.originalName ?? `${base}.${ext}`;
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const store = getBulkStore();
  if (opts.preferSignedUrl) {
    const url = await store.signedGetUrl(key, 300);
    if (url) return { filename, contentType, url, bytes: null };
  }
  const bytes = await store.get(key);
  if (!bytes) throw new DomainError("not_found", "The file is no longer available", undefined, "bulk.fileNoLongerAvailable");
  return { filename, contentType, url: null, bytes };
}

/** Scheduled: delete files of jobs older than the retention period and mark them expired. Returns how many. */
export async function purgeExpiredJobs(now = new Date(), batch = 200): Promise<number> {
  const rows = await prisma.bulkJob.findMany({
    where: { expiresAt: { lte: now }, status: { notIn: ["expired", "queued", "processing", "validating"] } },
    orderBy: { expiresAt: "asc" },
    take: batch,
  });
  const store = getBulkStore();
  for (const j of rows) {
    for (const k of [j.sourceKey, j.resultKey, j.errorReportKey]) if (k) await store.delete(k).catch((e) => console.error("[bulk] purge delete failed", k, e));
    await prisma.bulkJob.update({ where: { id: j.id }, data: { status: "expired", sourceKey: null, resultKey: null, errorReportKey: null, sampleErrors: [], expiresAt: null } });
  }
  return rows.length;
}

export type { FileFormat };
