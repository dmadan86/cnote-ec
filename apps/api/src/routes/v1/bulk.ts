import { z } from "@hono/zod-openapi";
import { DomainError } from "@cnote/core";
import * as ops from "../../ops";
import { Id } from "../../schemas";
import { api, body, json, router } from "../helpers";

export const bulkRoutes = router();
const iso = (example: string) => z.string().openapi({ format: "date-time", example });

const RowError = z.object({ row: z.number().int().openapi({ description: "Spreadsheet row number (header is row 1); 0 = whole file." }), column: z.string(), message: z.string() }).openapi("BulkRowError");
const BulkJob = z
  .object({
    id: z.string().openapi({ format: "uuid" }),
    kind: z.enum(["import", "export"]),
    status: z.enum(["uploaded", "validating", "validated", "queued", "processing", "completed", "completed_with_errors", "failed", "cancelled", "expired"]).openapi({
      description: "Import flow: uploaded -> validating -> validated (dry run done; call confirm) -> queued -> processing -> completed | completed_with_errors. Exports go queued -> processing -> completed.",
    }),
    format: z.string().openapi({ example: "zip" }),
    originalName: z.string().nullable(),
    options: z.record(z.string(), z.unknown()),
    totalRows: z.number().int(),
    processedRows: z.number().int(),
    createdCount: z.number().int(),
    updatedCount: z.number().int(),
    errorCount: z.number().int().openapi({ description: "Rows with at least one problem." }),
    imageCount: z.number().int(),
    sampleErrors: z.array(RowError).openapi({ description: "First 50 problems. The full list is in the error report download." }),
    lastError: z.string().nullable(),
    hasSource: z.boolean(),
    hasResult: z.boolean(),
    hasErrorReport: z.boolean(),
    active: z.boolean().openapi({ description: "true while the job is validating, queued or processing: keep polling." }),
    createdAt: iso("2026-09-29T10:00:00.000Z"),
    startedAt: iso("2026-09-29T10:00:05.000Z").nullable(),
    finishedAt: iso("2026-09-29T10:01:00.000Z").nullable(),
    expiresAt: iso("2026-10-06T10:00:00.000Z").nullable().openapi({ description: "Files are deleted 7 days after the job finishes." }),
  })
  .openapi("BulkJob");

const ImportForm = z.object({
  file: z.any().openapi({ type: "string", format: "binary", description: ".csv, .xlsx or .zip (products.csv|xlsx plus an images/ folder), up to 200 MB." }),
  mode: z.enum(["create", "upsert"]).default("upsert").openapi({ description: "`create` rejects rows whose SKU exists; `upsert` updates existing listings matched by SKU." }),
  submit_for_review: z.enum(["true", "false"]).default("false").openapi({ description: "Submit every imported listing for review. Nothing goes live without review either way." }),
});
const ConfirmBody = z.object({ skipInvalid: z.boolean().default(false).openapi({ description: "Import the valid rows even though some rows have errors." }) }).partial();
const ExportBody = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx"), includeImages: z.boolean().default(false).openapi({ description: "Download a ZIP with the products file and an images/ folder." }) });
const DownloadQuery = z.object({ which: z.enum(["result", "errors", "source"]).default("result").openapi({ description: "`result` = export file, `errors` = row-level error report, `source` = the uploaded file." }) });
const tag = ["Bulk import and export"];
const sellerNote = "Requires a key bound to a seller business.";

bulkRoutes.openapi(
  api({
    scope: "listings:write", errors: [409, 422],
    cfg: {
      method: "post", path: "/seller/bulk/imports", operationId: "createBulkImport", tags: tag, summary: "Upload a file to import listings",
      description: `Multipart upload of a .csv, .xlsx or .zip. The file is validated as a **dry run**: poll \`GET /seller/bulk/jobs/{id}\` until \`status\` is \`validated\`, inspect \`sampleErrors\` / the error report, then call the confirm endpoint. Nothing is imported before you confirm. Imports write your drafts (working copies); uploaded images go through staff approval. Limits: 5,000 rows, 200 MB, 10 imports per hour, one active import at a time. ${sellerNote}`,
      request: { body: { required: true, content: { "multipart/form-data": { schema: ImportForm } } } },
      responses: { 201: json(BulkJob, "The import job (validated inline for small files)") },
    },
  }),
  async (c) => {
    ops.bulkAssertSeller(c.get("principal"));
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new DomainError("validation", "Send the file in a multipart field named `file`");
    const job = await ops.bulkImport(c.get("principal"), { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name }, {
      mode: form.mode === "create" ? "create" : "upsert",
      submitForReview: form.submit_for_review === "true",
    });
    return c.json(job, 201);
  },
);

bulkRoutes.openapi(
  api({
    scope: "listings:read", errors: [404],
    cfg: {
      method: "get", path: "/seller/bulk/jobs/{id}", operationId: "getBulkJob", tags: tag, summary: "Get an import or export job",
      description: `Status, progress counters and the first 50 row errors. ${sellerNote}`,
      request: { params: Id },
      responses: { 200: json(BulkJob, "The job") },
    },
  }),
  async (c) => c.json(await ops.bulkJob(c.get("principal"), c.req.valid("param").id), 200),
);

bulkRoutes.openapi(
  api({
    scope: "listings:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/seller/bulk/jobs/{id}/confirm", operationId: "confirmBulkImport", tags: tag, summary: "Confirm a validated import",
      description: `Starts the import of a job in status \`validated\`. If some rows have errors you must pass \`skipInvalid: true\` to import only the valid rows. ${sellerNote}`,
      request: { params: Id, body: { required: false, content: { "application/json": { schema: ConfirmBody } } } },
      responses: { 202: json(BulkJob, "The job, now queued") },
    },
  }),
  async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const parsed = ConfirmBody.safeParse(b);
    if (!parsed.success) throw new DomainError("validation", "skipInvalid must be a boolean");
    return c.json(await ops.bulkConfirm(c.get("principal"), c.req.valid("param").id, !!parsed.data.skipInvalid), 202);
  },
);

bulkRoutes.openapi(
  api({
    scope: "listings:write", errors: [404, 409],
    cfg: {
      method: "post", path: "/seller/bulk/jobs/{id}/cancel", operationId: "cancelBulkJob", tags: tag, summary: "Cancel a job",
      description: `Stops an import that has not finished. Rows already imported stay in your drafts. ${sellerNote}`,
      request: { params: Id },
      responses: { 200: json(BulkJob, "The cancelled job") },
    },
  }),
  async (c) => c.json(await ops.bulkCancel(c.get("principal"), c.req.valid("param").id), 200),
);

bulkRoutes.openapi(
  api({
    scope: "listings:read", errors: [409, 422],
    cfg: {
      method: "post", path: "/seller/bulk/exports", operationId: "createBulkExport", tags: tag, summary: "Export your listings",
      description: `Queues an export of all your non-archived listings in the same columns as the import template (edit and re-import by SKU). Poll the job, then download the result. Listings without a SKU are assigned one. ${sellerNote}`,
      request: { body: body(ExportBody) },
      responses: { 202: json(BulkJob, "The export job") },
    },
  }),
  async (c) => c.json(await ops.bulkExport(c.get("principal"), c.req.valid("json") as { format: "xlsx" | "csv"; includeImages: boolean }), 202),
);

bulkRoutes.openapi(
  api({
    scope: "listings:read", errors: [404],
    cfg: {
      method: "get", path: "/seller/bulk/jobs/{id}/download", operationId: "downloadBulkFile", tags: tag, summary: "Download an export, error report or source file",
      description: `Redirects (302) to a short-lived signed URL when object storage supports it, otherwise streams the file. Files are kept for 7 days. ${sellerNote}`,
      request: { params: Id, query: DownloadQuery },
      responses: {
        200: { description: "The file", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        302: { description: "Redirect to a signed URL" },
      },
    },
  }),
  async (c) => {
    const { which } = c.req.valid("query");
    const dl = await ops.bulkDownload(c.get("principal"), c.req.valid("param").id, which);
    if (dl.url) return c.redirect(dl.url, 302) as never;
    return c.body(Buffer.from(dl.bytes!), 200, {
      "Content-Type": dl.contentType,
      "Content-Disposition": `attachment; filename="${dl.filename.replace(/[^\w.\- ]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    }) as never;
  },
);
