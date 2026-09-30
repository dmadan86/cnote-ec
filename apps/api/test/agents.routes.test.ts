import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, resetPrincipal, state } from "./helpers";

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: vi.fn(async () => true) }));
vi.mock("@cnote/developer", () => ({
  SCOPES: [],
  hasScope: (p: { scopes: string[] }, s: string) => p.scopes.includes(s) || (s.endsWith(":read") && p.scopes.includes(s.replace(":read", ":write"))),
  verifyApiKey: vi.fn(async (secret: string) => (secret === "ck_live_testsecret" ? state.principal : null)),
}));

const NEG = { id: "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10", status: "open", youAre: "buyer" };
const a2a = {
  listMandates: vi.fn(async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }]),
  getMandate: vi.fn(async (_b: string, id: string) => (id === "missing" ? null : { id })),
  listNegotiations: vi.fn(async () => [{ id: "n1" }]),
  getNegotiation: vi.fn(async () => NEG),
  startNegotiation: vi.fn(async () => NEG),
  sendNegotiationMessage: vi.fn(async () => NEG),
};
vi.mock("@cnote/a2a", () => ({
  listMandates: (...a: unknown[]) => (a2a.listMandates as (...x: unknown[]) => unknown)(...a),
  getMandate: (...a: unknown[]) => (a2a.getMandate as (...x: unknown[]) => unknown)(...a),
  listNegotiations: (...a: unknown[]) => (a2a.listNegotiations as (...x: unknown[]) => unknown)(...a),
  getNegotiation: (...a: unknown[]) => (a2a.getNegotiation as (...x: unknown[]) => unknown)(...a),
  startNegotiation: (...a: unknown[]) => (a2a.startNegotiation as (...x: unknown[]) => unknown)(...a),
  sendNegotiationMessage: (...a: unknown[]) => (a2a.sendNegotiationMessage as (...x: unknown[]) => unknown)(...a),
}));

const { DomainError } = await import("@cnote/core");
const { authenticate } = await import("../src/middleware/auth");
const { toErrorResponse } = await import("../src/lib/errors");
const { validationHook } = await import("../src/routes/helpers");
const { agentRoutes } = await import("../src/routes/v1/agents");

const app = new OpenAPIHono<{ Variables: { principal: never; requestId: string } }>({ defaultHook: validationHook as never });
app.use("*", async (c, next) => { c.set("requestId", "req-1"); await next(); });
app.onError((err, c) => {
  const { status, body, headers } = toErrorResponse(err, c.get("requestId"));
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json(body, status);
});
app.use("/v1/*", authenticate("rest") as never);
app.route("/v1", agentRoutes as never);
app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "t", version: "1" } });

const NID = NEG.id;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { authorization: "Bearer ck_live_testsecret", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const offer = { pricePaise: 100000, quantity: 10, unit: "pc", leadTimeDays: 5, validUntil: "2026-12-01" };

beforeEach(() => {
  resetPrincipal(["agents:read", "agents:write"]);
  vi.clearAllMocks();
});

describe("agent routes auth", () => {
  it("401 without key", async () => expect((await app.request("/v1/agents/mandates")).status).toBe(401));
  it("403 when the scope is missing, naming it", async () => {
    resetPrincipal(["agents:read"]);
    const r = await post(`/v1/agents/negotiations`, { mandateId: NID, matchId: NID });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain("agents:write");
  });
  it("write implies read", async () => {
    resetPrincipal(["agents:write"]);
    expect((await app.request("/v1/agents/mandates", auth())).status).toBe(200);
  });
  it("rejects a key that is not bound to a business", async () => {
    resetPrincipal(["agents:read", "agents:write"], null);
    const r = await app.request("/v1/agents/mandates", auth());
    expect(r.status).toBe(403);
    expect(a2a.listMandates).not.toHaveBeenCalled();
  });
});

describe("agent routes behaviour", () => {
  it("lists mandates for the key's business with pagination", async () => {
    const r = await app.request("/v1/agents/mandates?limit=2", auth());
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.items).toHaveLength(2);
    expect(b.nextCursor).toBeTruthy();
    expect(a2a.listMandates).toHaveBeenCalledWith("b1", expect.anything());
  });
  it("404 for a missing mandate", async () => expect((await app.request("/v1/agents/mandates/missing", auth())).status).toBe(404));
  it("gets a negotiation acting as the business", async () => {
    const r = await app.request(`/v1/agents/negotiations/${NID}`, auth());
    expect(r.status).toBe(200);
    expect(a2a.getNegotiation).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, NID);
  });
  it("lists negotiations with a status filter", async () => {
    expect((await app.request("/v1/agents/negotiations?status=open&side=buyer", auth())).status).toBe(200);
    expect(a2a.listNegotiations).toHaveBeenCalledWith("b1", expect.objectContaining({ status: "open", side: "buyer" }));
    expect((await app.request("/v1/agents/negotiations?status=bogus", auth())).status).toBe(422);
  });
  it("starts a negotiation as an external agent, passing the key as startKey", async () => {
    const r = await post("/v1/agents/negotiations", { mandateId: NID, matchId: NID }, { "idempotency-key": "start-1" });
    expect(r.status).toBe(201);
    expect(a2a.startNegotiation).toHaveBeenCalledWith(
      { personId: "p1", businessId: "b1" }, { mandateId: NID, matchId: NID, startKey: "start-1" }, { kind: "external_agent", apiKeyId: "k1" },
    );
  });
  it("start works without a key", async () => {
    expect((await post("/v1/agents/negotiations", { mandateId: NID, matchId: NID })).status).toBe(201);
    expect((a2a.startNegotiation.mock.calls[0] as unknown[])[1]).toMatchObject({ startKey: null });
  });
  it("maps a not-enabled conflict to 409", async () => {
    a2a.startNegotiation.mockRejectedValueOnce(new DomainError("conflict", "Agent-to-agent commerce is not enabled"));
    expect((await post("/v1/agents/negotiations", { mandateId: NID, matchId: NID })).status).toBe(409);
  });
});

describe("messages", () => {
  const path = `/v1/agents/negotiations/${NID}/messages`;
  it("requires Idempotency-Key (422)", async () => {
    const r = await post(path, { type: "accept" });
    expect(r.status).toBe(422);
    expect(a2a.sendNegotiationMessage).not.toHaveBeenCalled();
  });
  it("validates the body (422)", async () => {
    expect((await post(path, { type: "counter" }, { "idempotency-key": "k" })).status).toBe(422);
    expect((await post(path, { type: "offer", offer: { ...offer, pricePaise: -1 } }, { "idempotency-key": "k" })).status).toBe(422);
    expect((await post(path, { type: "confirm" }, { "idempotency-key": "k" })).status).toBe(422);
  });
  it("passes the same key through on a replay and returns the same result", async () => {
    const r1 = await post(path, { type: "counter", offer }, { "idempotency-key": "same" });
    const r2 = await post(path, { type: "counter", offer }, { "idempotency-key": "same" });
    expect(r1.status).toBe(201);
    expect(await r2.json()).toEqual(await r1.json());
    for (const call of a2a.sendNegotiationMessage.mock.calls as unknown[][]) {
      expect(call[3]).toEqual({ idempotencyKey: "same", via: { kind: "external_agent", apiKeyId: "k1" } });
    }
  });
  it("accepts typed accept/reject/withdraw", async () => {
    for (const type of ["accept", "reject", "withdraw"]) expect((await post(path, { type }, { "idempotency-key": type })).status).toBe(201);
  });
  it("maps rate_limited to 429 with Retry-After", async () => {
    a2a.sendNegotiationMessage.mockRejectedValueOnce(new DomainError("rate_limited", "slow", { retryAfterSeconds: 9 }));
    const r = await post(path, { type: "accept" }, { "idempotency-key": "x" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("9");
  });
  it("has no confirm endpoint", async () => {
    expect((await post(`/v1/agents/negotiations/${NID}/confirm`, {}, {})).status).toBe(404);
  });
});

describe("openapi", () => {
  it("documents the paths with x-required-scope", async () => {
    const doc = await (await app.request("/openapi.json")).json();
    const p = (k: string) => doc.paths[`/agents${k}`] ?? doc.paths[`/v1/agents${k}`];
    expect(p("/mandates").get["x-required-scope"]).toBe("agents:read");
    expect(p("/mandates/{id}").get["x-required-scope"]).toBe("agents:read");
    expect(p("/negotiations").get["x-required-scope"]).toBe("agents:read");
    expect(p("/negotiations").post["x-required-scope"]).toBe("agents:write");
    expect(p("/negotiations/{id}").get["x-required-scope"]).toBe("agents:read");
    expect(p("/negotiations/{id}/messages").post["x-required-scope"]).toBe("agents:write");
    expect(Object.keys(doc.paths).some((k) => k.includes("confirm"))).toBe(false);
  });
});
