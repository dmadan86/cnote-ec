import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEY, auth, resetPrincipal, state } from "./helpers";

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
vi.mock("@cnote/bulk", () => ({}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()) }));

const s = vi.hoisted(() => ({
  enabled: true,
  samplesEnabled: () => s.enabled,
  requestSample: vi.fn(), listBuyerSamples: vi.fn(), listSellerSamples: vi.fn(), getSample: vi.fn(), cancelSample: vi.fn(), acceptSample: vi.fn(),
  declineSample: vi.fn(), dispatchSample: vi.fn(), markSampleDelivered: vi.fn(), recordSamplePayment: vi.fn(), evaluateSample: vi.fn(),
  acceptLinkedQuote: vi.fn(), linkBulkEnquiry: vi.fn(), getBulkPrefill: vi.fn(), getSellerSampleStats: vi.fn(),
}));
vi.mock("@cnote/samples", () => s);

const { createApp } = await import("../src/app");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });
const ID = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10";
const view = { id: ID, role: "buyer", status: "requested", payment: { amountPaise: 0 } };
const post = (path: string, body?: unknown) =>
  app.request(`/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

beforeEach(() => {
  s.enabled = true;
  resetPrincipal(["samples:write"], "b1");
  for (const [k, f] of Object.entries(s)) if (typeof f === "function" && k !== "samplesEnabled") (f as ReturnType<typeof vi.fn>).mockReset();
  for (const k of ["requestSample", "getSample", "cancelSample", "acceptSample", "declineSample", "dispatchSample", "markSampleDelivered", "recordSamplePayment", "evaluateSample", "acceptLinkedQuote", "linkBulkEnquiry"] as const) s[k].mockResolvedValue(view);
});

describe("samples API", () => {
  it("is invisible (404) while SAMPLES_ENABLED is off", async () => {
    s.enabled = false;
    resetPrincipal(["samples:read"], "b1");
    expect((await app.request("/v1/samples", auth())).status).toBe(404);
    expect((await app.request(`/v1/samples/${ID}`, auth())).status).toBe(404);
  });

  it("requests a sample as the key's business and adds the currency", async () => {
    const shipTo = { name: "Asha Rao", line1: "12 MG Road", city: "Bengaluru", pincode: "560001" };
    const r = await post("/samples", { listingId: ID, quantity: 2, shipTo });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: ID, currency: "INR" });
    expect(s.requestSample).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, expect.objectContaining({ listingId: ID, quantity: 2 }));
    expect((await post("/samples", { listingId: ID, quantity: 0, shipTo })).status).toBe(422);
  });

  it("lists by role with cursor pagination and reads one", async () => {
    resetPrincipal(["samples:read"], "b1");
    s.listSellerSamples.mockResolvedValue([{ id: ID }]);
    const r = await app.request("/v1/samples?role=seller&filter=open", auth());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [{ id: ID }], nextCursor: null });
    expect(s.listSellerSamples).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, { filter: "open", limit: 200 });
    s.getSample.mockResolvedValueOnce(null);
    expect((await app.request(`/v1/samples/${ID}`, auth())).status).toBe(404);
    expect((await app.request(`/v1/samples/${ID}`, auth())).status).toBe(200);
  });

  it("routes every action to the module with its input", async () => {
    expect((await post(`/samples/${ID}/accept`, { amountPaise: 100, adjustableAgainstBulk: true })).status).toBe(200);
    expect(s.acceptSample).toHaveBeenCalledWith(expect.anything(), ID, expect.objectContaining({ amountPaise: 100, adjustableAgainstBulk: true }));
    expect((await post(`/samples/${ID}/decline`, { reason: "out_of_stock" })).status).toBe(200);
    expect((await post(`/samples/${ID}/decline`, { reason: "nope" })).status).toBe(422);
    expect((await post(`/samples/${ID}/dispatch`, { courier: "Delhivery" })).status).toBe(200);
    expect((await post(`/samples/${ID}/delivered`)).status).toBe(200);
    expect((await post(`/samples/${ID}/cancel`)).status).toBe(200);
    expect((await post(`/samples/${ID}/payment`, { note: "UPI" })).status).toBe(200);
    expect(s.recordSamplePayment).toHaveBeenCalledWith(expect.anything(), ID, "UPI");
    expect((await post(`/samples/${ID}/evaluate`, { approved: false, reasons: ["finish_defect"] })).status).toBe(200);
    expect((await post(`/samples/${ID}/accept-quote`)).status).toBe(200);
    expect((await post(`/samples/${ID}/bulk-enquiry`, { enquiryId: ID })).status).toBe(200);
    expect(s.linkBulkEnquiry).toHaveBeenCalledWith(expect.anything(), ID, ID);
  });

  it("prefill and public seller stats", async () => {
    resetPrincipal(["samples:read", "catalogue:read"], "b1");
    s.getBulkPrefill.mockResolvedValue({ sampleId: ID, subject: "x", sellerBusinessId: ID, sellerName: "S", listingId: null, categorySlug: null, quantityUnit: null, quoteId: null, requirementNote: "ref" });
    expect((await app.request(`/v1/samples/${ID}/bulk-prefill`, auth())).status).toBe(200);
    s.getSellerSampleStats.mockResolvedValue(new Map([[ID, { sellerBusinessId: ID, evaluated: 6, approved: 5, approvalRate: 5 / 6, expired: 0, responded: 6 }]]));
    expect(await (await app.request(`/v1/sellers/${ID}/sample-stats`, auth())).json()).toMatchObject({ evaluated: 6, approvalRate: 5 / 6 });
    s.getSellerSampleStats.mockResolvedValue(new Map());
    expect((await app.request(`/v1/sellers/${ID}/sample-stats`, auth())).status).toBe(404);
  });

  it("refuses keys without the scope or a business", async () => {
    resetPrincipal(["samples:read"], "b1");
    expect((await post("/samples", {})).status).toBe(403);
    resetPrincipal(["samples:write"], null);
    expect((await post(`/samples/${ID}/cancel`)).status).toBe(403);
  });
});
