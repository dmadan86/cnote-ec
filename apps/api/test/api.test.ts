import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, jsonReq, resetPrincipal, state } from "./helpers";

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: vi.fn(async () => true) }));
vi.mock("@cnote/developer", () => ({
  SCOPES: [],
  hasScope: (p: { scopes: string[] }, s: string) => p.scopes.includes(s) || (s.endsWith(":read") && p.scopes.includes(s.replace(":read", ":write"))),
  verifyApiKey: vi.fn(async (secret: string) => {
    if (state.verifyThrows) throw state.verifyThrows;
    return secret === "ck_live_testsecret" ? state.principal : null;
  }),
}));
const hit = {
  listing: { id: "l1", sellerBusinessId: "b2", category: { id: "c", slug: "s", name: "S" }, title: "Bolt", description: "d", attributes: {}, pricePaise: 100, priceUnit: "pc", moq: 1, moqUnit: "pc", hsn: null, language: "en", imageUrls: [], aiGenerated: false, status: "published", moderationStatus: "approved", moderationReason: null, createdAt: "x", updatedAt: "x" },
  seller: { businessId: "b2", name: "Acme", city: null, state: null, pincode: null, verificationTier: 2, trustScore: 80, badgeActive: true, languages: [] },
  score: 0.9, sponsored: false,
};
const searchListings = vi.fn(async () => ({ hits: [hit], tookMs: 3 }));
vi.mock("@cnote/search", () => ({ searchListings: (...a: unknown[]) => (searchListings as (...x: unknown[]) => unknown)(...a) }));
const createEnquiry = vi.fn(async (_a: unknown, i: { title: string }) => ({ id: "e1", title: i.title, requirement: "r", category: null, quantity: null, quantityUnit: null, targetPricePaise: 500, deliveryCity: null, deliveryPincode: null, neededBy: null, intentScore: 0.8, intentReasons: [], status: "matched", createdAt: "2026-09-01T00:00:00.000Z", matches: [] }));
vi.mock("@cnote/enquiry", () => ({ createEnquiry: (...a: [unknown, { title: string }]) => createEnquiry(...a) }));
vi.mock("@cnote/catalogue", () => ({}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()) }));
vi.mock("@cnote/billing", () => ({}));
vi.mock("@cnote/reviews", () => ({}));
vi.mock("@cnote/wishlist", () => ({}));

const { createApp } = await import("../src/app");
const { rateLimit, DomainError } = await import("@cnote/core");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });

beforeEach(() => resetPrincipal(["search:read", "enquiries:write", "catalogue:read"]));

describe("auth", () => {
  it("401 without a key", async () => {
    const r = await app.request("/v1/search?q=bolt");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
    const b = await r.json();
    expect(b.error).toMatchObject({ code: "unauthenticated" });
    expect(b.error.requestId).toBeTruthy();
  });
  it("401 with a bad key", async () => {
    const r = await app.request("/v1/search?q=bolt", auth("ck_live_wrong"));
    expect(r.status).toBe(401);
    expect((await r.json()).error.message).toMatch(/invalid/i);
  });
  it("403 names the missing scope", async () => {
    resetPrincipal(["search:read"]);
    const r = await app.request("/v1/categories", auth());
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain("catalogue:read");
  });
  it("write scope implies read", async () => {
    resetPrincipal(["enquiries:write"]);
    const r = await app.request("/v1/enquiries/x", auth());
    expect(r.status).not.toBe(403);
  });
  it("429 with Retry-After when the key is over its limit", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce(false);
    const r = await app.request("/v1/search?q=bolt", auth());
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("maps a rate_limited DomainError from the key verifier", async () => {
    state.verifyThrows = new DomainError("rate_limited", "slow down", { retryAfterSeconds: 7 });
    const r = await app.request("/v1/search?q=bolt", auth());
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("7");
  });
});

describe("routes", () => {
  it("GET /v1/search returns trust-ranked hits with sponsored:false and no seller-only fields", async () => {
    const r = await app.request("/v1/search?q=bolt&limit=5", auth());
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.items[0]).toMatchObject({ sponsored: false, score: 0.9 });
    expect(b.items[0].listing).toMatchObject({ currency: "INR", pricePaise: 100 });
    expect(b.items[0].listing.moderationStatus).toBeUndefined();
    expect(searchListings).toHaveBeenCalledWith({ q: "bolt", categorySlug: undefined, limit: 5 });
  });
  it("422 with issues on bad query", async () => {
    const r = await app.request("/v1/search?q=bolt&limit=999", auth());
    expect(r.status).toBe(422);
    expect((await r.json()).error.issues.length).toBeGreaterThan(0);
  });
  it("POST /v1/enquiries acts as the key's person + business", async () => {
    const r = await app.request("/v1/enquiries", jsonReq({ title: "500 kg steel sheets", requirement: "Need 500 kg of SS304 sheets by month end." }));
    expect(r.status).toBe(201);
    expect((await r.json())).toMatchObject({ id: "e1", currency: "INR" });
    expect(createEnquiry.mock.calls[0]?.[0]).toEqual({ personId: "p1", businessId: "b1" });
  });
  it("403 when the key has no business", async () => {
    resetPrincipal(["enquiries:write"], null);
    const r = await app.request("/v1/enquiries", jsonReq({ title: "500 kg steel sheets", requirement: "Need 500 kg of SS304 sheets by month end." }));
    expect(r.status).toBe(403);
  });
  it("health, docs and openapi are public", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/docs")).status).toBe(200);
    expect((await app.request("/openapi.json")).status).toBe(200);
  });
});

describe("openapi", () => {
  it("is a valid-looking 3.1 document with security on every operation", async () => {
    const spec = await (await app.request("/openapi.json")).json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const ids = new Set<string>();
    for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
      expect(path.startsWith("/v1/")).toBe(true);
      for (const op of Object.values(item)) {
        expect(op.operationId).toBeTruthy();
        expect(ids.has(op.operationId)).toBe(false);
        ids.add(op.operationId);
        expect(op.security).toEqual([{ bearerAuth: [] }]);
        expect(op["x-required-scope"]).toBeTruthy();
        expect(op.responses["401"]).toBeTruthy();
        expect(op.tags?.length).toBeGreaterThan(0);
      }
    }
    expect(ids.size).toBeGreaterThanOrEqual(25);
  });
});

describe("mcp", () => {
  const rpc = (method: string, params: unknown, id = 1) => jsonReq({ jsonrpc: "2.0", id, method, params });
  const init = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } };

  it("401 without a key", async () => {
    const r = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });
  it("tools/list only includes tools the scopes allow", async () => {
    resetPrincipal(["search:read", "catalogue:read"]);
    const r = await app.request("/mcp", rpc("tools/list", {}));
    expect(r.status).toBe(200);
    const names = (await r.json()).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["get_listing", "get_seller_profile", "list_categories", "search_products"]);
  });
  it("initialize works", async () => {
    const r = await app.request("/mcp", rpc("initialize", init));
    expect(r.status).toBe(200);
    expect((await r.json()).result.serverInfo.name).toBe("cnote");
  });
  it("tools/call runs a tool and returns structured content", async () => {
    const r = await app.request("/mcp", rpc("tools/call", { name: "search_products", arguments: { q: "bolt" } }));
    const res = (await r.json()).result;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.items[0].sponsored).toBe(false);
    expect(JSON.parse(res.content[0].text).items).toHaveLength(1);
  });
  it("a tool the key lacks is unknown", async () => {
    const r = await app.request("/mcp", rpc("tools/call", { name: "accept_lead", arguments: { matchId: "m1" } }));
    const b = await r.json();
    expect(b.error ?? b.result.isError).toBeTruthy();
  });
  it("tool failures come back as isError with the domain message", async () => {
    resetPrincipal(["enquiries:write"], null);
    const r = await app.request("/mcp", rpc("tools/call", { name: "create_enquiry", arguments: { title: "500 kg steel", requirement: "Need SS304 sheets, 500kg." } }));
    const res = (await r.json()).result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not bound to a business");
  });
});
