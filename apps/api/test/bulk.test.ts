import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEY, auth, jsonReq, resetPrincipal, state } from "./helpers";

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: vi.fn(async () => true) }));
vi.mock("@cnote/developer", () => ({
  SCOPES: [],
  hasScope: (p: { scopes: string[] }, s: string) => p.scopes.includes(s) || (s.endsWith(":read") && p.scopes.includes(s.replace(":read", ":write"))),
  verifyApiKey: vi.fn(async (secret: string) => (secret === "ck_live_testsecret" ? state.principal : null)),
}));
vi.mock("@cnote/search", () => ({}));
vi.mock("@cnote/enquiry", () => ({}));
vi.mock("@cnote/catalogue", () => ({}));
vi.mock("@cnote/billing", () => ({}));
vi.mock("@cnote/reviews", () => ({}));
vi.mock("@cnote/wishlist", () => ({}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()) }));

const job = {
  id: "11111111-1111-4111-8111-111111111111", kind: "import", status: "validated", format: "csv", originalName: "p.csv", options: {},
  totalRows: 2, processedRows: 0, createdCount: 0, updatedCount: 0, errorCount: 0, imageCount: 0, sampleErrors: [], lastError: null,
  hasSource: true, hasResult: false, hasErrorReport: false, active: false,
  createdAt: "2026-09-29T10:00:00.000Z", startedAt: null, finishedAt: null, expiresAt: null,
};
const bulk = vi.hoisted(() => ({
  createImportJob: vi.fn(), getJob: vi.fn(), confirmImportJob: vi.fn(), cancelJob: vi.fn(), createExportJob: vi.fn(), getDownload: vi.fn(),
}));
vi.mock("@cnote/bulk", () => bulk);

const { createApp } = await import("../src/app");
const { DomainError } = await import("@cnote/core");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });
const ID = job.id;

beforeEach(() => {
  resetPrincipal(["listings:write"], "b1");
  for (const f of Object.values(bulk)) f.mockReset();
  bulk.createImportJob.mockResolvedValue(job);
  bulk.getJob.mockResolvedValue(job);
  bulk.confirmImportJob.mockResolvedValue({ ...job, status: "queued", active: true });
  bulk.cancelJob.mockResolvedValue({ ...job, status: "cancelled" });
  bulk.createExportJob.mockResolvedValue({ ...job, kind: "export", status: "queued", active: true });
});

function upload(fields: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return app.request("/v1/seller/bulk/imports", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: fd });
}

describe("POST /v1/seller/bulk/imports", () => {
  it("creates an upsert dry-run job by default from a multipart file", async () => {
    const r = await upload({ file: new File(["sku,title\nA,B\n"], "products.csv", { type: "text/csv" }) });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: ID, status: "validated" });
    const [actor, file, opts] = bulk.createImportJob.mock.calls[0]!;
    expect(actor).toEqual({ personId: "p1", businessId: "b1" });
    expect(file.filename).toBe("products.csv");
    expect(new TextDecoder().decode(file.bytes)).toContain("sku,title");
    expect(opts).toEqual({ mode: "upsert", submitForReview: false });
  });

  it("honours mode=create and submit_for_review=true", async () => {
    await upload({ file: new File(["x"], "p.xlsx"), mode: "create", submit_for_review: "true" });
    expect(bulk.createImportJob.mock.calls[0]![2]).toEqual({ mode: "create", submitForReview: true });
  });

  it("422 when the multipart field `file` is missing or not a file", async () => {
    const r = await upload({ file: "not-a-file" });
    expect(r.status).toBe(422);
    expect(bulk.createImportJob).not.toHaveBeenCalled();
  });

  it("403 for a key that is not bound to a business", async () => {
    resetPrincipal(["listings:write"], null);
    const r = await upload({ file: new File(["x"], "p.csv") });
    expect(r.status).toBe(403);
    expect(bulk.createImportJob).not.toHaveBeenCalled();
  });

  it("403 without listings:write", async () => {
    resetPrincipal(["listings:read"], "b1");
    expect((await upload({ file: new File(["x"], "p.csv") })).status).toBe(403);
  });

  it("maps module conflicts (one active import) to 409", async () => {
    bulk.createImportJob.mockRejectedValueOnce(new DomainError("conflict", "An import is already running"));
    const r = await upload({ file: new File(["x"], "p.csv") });
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toContain("already running");
  });
});

describe("jobs", () => {
  it("GET returns the job (listings:write implies read)", async () => {
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}`, auth());
    expect(r.status).toBe(200);
    expect(bulk.getJob).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, ID);
  });

  it("GET 404 (not 500) when Postgres rejects a malformed id", async () => {
    bulk.getJob.mockRejectedValueOnce(Object.assign(new Error('invalid input syntax for type uuid: "nope"'), { code: "22P02" }));
    const r = await app.request("/v1/seller/bulk/jobs/nope", auth());
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
  });

  it("GET 404 when the job belongs to another seller", async () => {
    bulk.getJob.mockRejectedValueOnce(new DomainError("not_found", "Job not found"));
    expect((await app.request(`/v1/seller/bulk/jobs/${ID}`, auth())).status).toBe(404);
  });

  it("confirm defaults skipInvalid to false with no body", async () => {
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}/confirm`, { method: "POST", ...auth() });
    expect(r.status).toBe(202);
    expect(bulk.confirmImportJob).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, ID, { skipInvalid: false });
  });

  it("confirm passes skipInvalid=true", async () => {
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}/confirm`, jsonReq({ skipInvalid: true }));
    expect(r.status).toBe(202);
    expect(bulk.confirmImportJob.mock.calls[0]![2]).toEqual({ skipInvalid: true });
  });

  it("confirm 422 when skipInvalid is not a boolean", async () => {
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}/confirm`, jsonReq({ skipInvalid: "yes" }));
    expect(r.status).toBe(422);
    expect(bulk.confirmImportJob).not.toHaveBeenCalled();
  });

  it("cancel returns the cancelled job", async () => {
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}/cancel`, { method: "POST", ...auth() });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("cancelled");
  });

  it("export queues a job with the requested format", async () => {
    const r = await app.request("/v1/seller/bulk/exports", jsonReq({ format: "csv", includeImages: true }));
    expect(r.status).toBe(202);
    expect(bulk.createExportJob).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, { format: "csv", includeImages: true });
  });
});

describe("GET /v1/seller/bulk/jobs/{id}/download", () => {
  it("redirects to a signed URL when storage supports it", async () => {
    bulk.getDownload.mockResolvedValueOnce({ url: "https://r2.example/signed?x=1" });
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}/download?which=errors`, auth());
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://r2.example/signed?x=1");
    expect(bulk.getDownload).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, ID, "errors", { preferSignedUrl: true });
  });

  it("streams bytes with a sanitised filename and no-store caching", async () => {
    bulk.getDownload.mockResolvedValueOnce({ bytes: new TextEncoder().encode("a,b"), contentType: "text/csv", filename: 'export"; evil\r\n.csv' });
    const r = await app.request(`/v1/seller/bulk/jobs/${ID}/download`, auth());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("a,b");
    expect(r.headers.get("content-type")).toBe("text/csv");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="export_ evil_.csv"');
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bulk.getDownload.mock.calls[0]![2]).toBe("result");
  });
});
