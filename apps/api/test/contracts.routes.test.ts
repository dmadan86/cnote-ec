import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, resetPrincipal, state } from "./helpers";

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: vi.fn(async () => true) }));
vi.mock("@cnote/developer", () => ({
  SCOPES: [],
  hasScope: (p: { scopes: string[] }, s: string) => p.scopes.includes(s) || (s.endsWith(":read") && p.scopes.includes(s.replace(":read", ":write"))),
  verifyApiKey: vi.fn(async (secret: string) => (secret === "ck_live_testsecret" ? state.principal : null)),
}));

const CID = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10";
const KEY = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d11";
const m = vi.hoisted(() => ({
  assertRateContractsEnabled: vi.fn(),
  listRateContracts: vi.fn(async () => ({ items: [{ id: "x" }], nextCursor: null })),
  getRateContract: vi.fn(async (_a: unknown, id: string) => (id === "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d99" ? null : { id, number: "RC/26-27/000001" })),
  placeCallOff: vi.fn(async () => ({
    callOff: { id: "co1", callOffNo: 1 }, orderId: "o1", purchaseOrder: { id: "po1", number: "PO/26-27/000001", status: "issued", totals: { totalPaise: 295000 } }, purchaseOrderError: null, contract: { id: "c" },
  })),
}));
vi.mock("@cnote/enquiry", () => m);

const { DomainError } = await import("@cnote/core");
const { authenticate } = await import("../src/middleware/auth");
const { toErrorResponse } = await import("../src/lib/errors");
const { validationHook } = await import("../src/routes/helpers");
const { contractRoutes } = await import("../src/routes/v1/contracts");

const app = new OpenAPIHono<{ Variables: { principal: never; requestId: string } }>({ defaultHook: validationHook as never });
app.use("*", async (c, next) => { c.set("requestId", "req-1"); await next(); });
app.onError((err, c) => {
  const { status, body, headers } = toErrorResponse(err, c.get("requestId"));
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json(body, status);
});
app.use("/v1/*", authenticate("rest") as never);
app.route("/v1", contractRoutes as never);
app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "t", version: "1" } });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { authorization: "Bearer ck_live_testsecret", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const lines = { lines: [{ itemKey: KEY, quantity: 100 }], addressId: KEY };

beforeEach(() => {
  resetPrincipal(["contracts:read", "contracts:write"]);
  vi.clearAllMocks();
});

describe("contract routes auth", () => {
  it("401 without a key", async () => expect((await app.request("/v1/contracts")).status).toBe(401));
  it("403 naming the scope", async () => {
    resetPrincipal(["contracts:read"]);
    const r = await post(`/v1/contracts/${CID}/call-offs`, lines, { "idempotency-key": "k" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain("contracts:write");
    resetPrincipal(["search:read"]);
    expect((await app.request("/v1/contracts", auth())).status).toBe(403);
  });
  it("write implies read", async () => {
    resetPrincipal(["contracts:write"]);
    expect((await app.request("/v1/contracts", auth())).status).toBe(200);
  });
  it("rejects a key that is not bound to a business", async () => {
    resetPrincipal(["contracts:read", "contracts:write"], null);
    expect((await app.request("/v1/contracts", auth())).status).toBe(403);
    expect((await post(`/v1/contracts/${CID}/call-offs`, lines, { "idempotency-key": "k" })).status).toBe(403);
    expect(m.listRateContracts).not.toHaveBeenCalled();
    expect(m.placeCallOff).not.toHaveBeenCalled();
  });
});

describe("contract routes behaviour", () => {
  it("lists as the key's business, defaulting to the buyer side, and passes filters", async () => {
    expect((await app.request("/v1/contracts", auth())).status).toBe(200);
    expect(m.listRateContracts).toHaveBeenLastCalledWith({ personId: "p1", businessId: "b1" }, { role: "buyer", status: null, cursor: null, limit: 25 });
    await app.request("/v1/contracts?role=seller&status=active&limit=5", auth());
    expect(m.listRateContracts).toHaveBeenLastCalledWith({ personId: "p1", businessId: "b1" }, { role: "seller", status: "active", cursor: null, limit: 5 });
    expect((await app.request("/v1/contracts?status=bogus", auth())).status).toBe(422);
    expect((await app.request("/v1/contracts?role=admin", auth())).status).toBe(422);
  });

  it("gets one contract, 404 when it is missing or not yours", async () => {
    expect((await app.request(`/v1/contracts/${CID}`, auth())).status).toBe(200);
    expect(m.getRateContract).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, CID);
    expect((await app.request("/v1/contracts/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d99", auth())).status).toBe(404);
  });

  it("is hidden while the feature flag is off", async () => {
    m.assertRateContractsEnabled.mockImplementationOnce(() => { throw new DomainError("forbidden", "Rate contracts are not enabled."); });
    expect((await app.request("/v1/contracts", auth())).status).toBe(403);
  });
});

describe("call-offs", () => {
  const path = `/v1/contracts/${CID}/call-offs`;
  it("requires an Idempotency-Key (422) and a valid body (422)", async () => {
    expect((await post(path, lines)).status).toBe(422);
    expect((await post(path, { lines: [] }, { "idempotency-key": "k" })).status).toBe(422);
    expect((await post(path, { lines: [{ itemKey: KEY, quantity: 0 }] }, { "idempotency-key": "k" })).status).toBe(422);
    expect(m.placeCallOff).not.toHaveBeenCalled();
  });

  it("places the call-off as the key's business with the idempotency key and returns the order and PO", async () => {
    const r = await post(path, { ...lines, expectedDelivery: "2026-11-15", notes: "Dock 2" }, { "idempotency-key": "run-1" });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b).toMatchObject({ orderId: "o1", purchaseOrder: { id: "po1", number: "PO/26-27/000001", totalPaise: 295000 }, purchaseOrderError: null });
    expect(m.placeCallOff).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, CID, expect.objectContaining({ idempotencyKey: "run-1", addressId: KEY, expectedDelivery: "2026-11-15", notes: "Dock 2" }));
  });

  it("maps domain errors: cap or window conflicts to 409, validation to 422, unknown contract to 404", async () => {
    m.placeCallOff.mockRejectedValueOnce(new DomainError("conflict", "This contract has expired. Start a renewal."));
    expect((await post(path, lines, { "idempotency-key": "a" })).status).toBe(409);
    m.placeCallOff.mockRejectedValueOnce(new DomainError("validation", "Line 1: the minimum per call-off for Box is 100 pcs."));
    expect((await post(path, lines, { "idempotency-key": "b" })).status).toBe(422);
    m.placeCallOff.mockRejectedValueOnce(new DomainError("not_found", "Rate contract not found"));
    expect((await post(path, lines, { "idempotency-key": "c" })).status).toBe(404);
  });

  it("the spec documents the scopes and the idempotency header", async () => {
    const spec = await (await app.request("/openapi.json")).json();
    const op = spec.paths["/v1/contracts/{id}/call-offs"].post;
    expect(op["x-required-scope"]).toBe("contracts:write");
    expect(op.parameters.map((p: { name: string }) => p.name)).toContain("idempotency-key");
    expect(spec.paths["/v1/contracts"].get["x-required-scope"]).toBe("contracts:read");
  });
});
