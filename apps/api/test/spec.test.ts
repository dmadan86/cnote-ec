import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, jsonReq, KEY, resetPrincipal, state } from "./helpers";

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(async (..._a: unknown[]) => true),
  getSellerLead: vi.fn(),
  acceptLead: vi.fn(),
  declineLead: vi.fn(),
  createEnquiry: vi.fn(),
  getBuyerEnquiry: vi.fn(),
  listBuyerEnquiries: vi.fn(),
  listSellerLeads: vi.fn(),
  getConversation: vi.fn(),
  sendMessage: vi.fn(),
  sendQuote: vi.fn(),
  reportDeal: vi.fn(),
  getBalance: vi.fn(),
  getActiveSubscription: vi.fn(),
  getTrustProfiles: vi.fn(),
  getListing: vi.fn(),
  archiveListing: vi.fn(), createListing: vi.fn(), getCategoryBySlug: vi.fn(), listCategories: vi.fn(async () => [] as unknown[]),
  listSellerListings: vi.fn(async () => [] as unknown[]), publishListing: vi.fn(), updateListing: vi.fn(),
  updateListingStock: vi.fn(), setListingVariants: vi.fn(),
  getPersonBusinesses: vi.fn(async () => [] as unknown[]), getPersonSummaries: vi.fn(async () => new Map()),
  getRatingSummary: vi.fn(), listApprovedReviews: vi.fn(), submitReview: vi.fn(),
  searchListings: vi.fn(async () => ({ hits: [] as unknown[] })),
  addItem: vi.fn(), getList: vi.fn(), listLists: vi.fn(async () => [] as unknown[]), removeItem: vi.fn(),
}));

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: m.rateLimit }));
vi.mock("@cnote/developer", () => ({
  // Mirrors packages/developer/src/scopes.ts hasScope (write implies read); the real module needs the DB layer.
  hasScope: (p: { scopes: readonly string[] }, s: string) => p.scopes.includes(s) || (s.endsWith(":read") && p.scopes.includes(s.replace(":read", ":write"))),
  verifyApiKey: vi.fn(async (secret: string) => {
    if (state.verifyThrows) throw state.verifyThrows;
    return secret === "ck_live_testsecret" ? state.principal : null;
  }),
}));
vi.mock("@cnote/billing", () => ({ getBalance: m.getBalance, getActiveSubscription: m.getActiveSubscription }));
vi.mock("@cnote/catalogue", () => ({
  archiveListing: m.archiveListing, createListing: m.createListing, getCategoryBySlug: m.getCategoryBySlug, getListing: m.getListing,
  listCategories: m.listCategories, listSellerListings: m.listSellerListings, publishListing: m.publishListing, updateListing: m.updateListing,
  updateListingStock: m.updateListingStock, setListingVariants: m.setListingVariants,
}));
vi.mock("@cnote/enquiry", () => ({
  acceptLead: m.acceptLead, createEnquiry: m.createEnquiry, declineLead: m.declineLead, getBuyerEnquiry: m.getBuyerEnquiry,
  getConversation: m.getConversation, getSellerLead: m.getSellerLead, listBuyerEnquiries: m.listBuyerEnquiries, listSellerLeads: m.listSellerLeads,
  reportDeal: m.reportDeal, sendMessage: m.sendMessage, sendQuote: m.sendQuote,
}));
vi.mock("@cnote/identity", () => ({ getPersonBusinesses: m.getPersonBusinesses, getPersonSummaries: m.getPersonSummaries, getTrustProfiles: m.getTrustProfiles }));
vi.mock("@cnote/reviews", () => ({ getRatingSummary: m.getRatingSummary, listApprovedReviews: m.listApprovedReviews, submitReview: m.submitReview }));
vi.mock("@cnote/search", () => ({ searchListings: m.searchListings }));
vi.mock("@cnote/wishlist", () => ({ addItem: m.addItem, getList: m.getList, listLists: m.listLists, removeItem: m.removeItem }));

const { createApp } = await import("../src/app");
const { paginate } = await import("../src/ops");
const { TOOLS: ALL_TOOLS } = await import("../src/mcp/tools");
const { AGENT_TOOLS } = await import("../src/mcp/tools/agents");
// Agent-to-agent tools (ADR-020) have their own suite (agents.mcp.test.ts); this one covers the core tools.
const TOOLS = ALL_TOOLS.filter((t) => !AGENT_TOOLS.some((a) => a.name === t.name));
const { SCOPE_DOCS } = await import("../src/scopes");
const { DomainError, HTTP_STATUS } = await import("@cnote/core");
const { hasScope } = await import("@cnote/developer");
const onServerError = vi.fn();
const app = createApp({ health: async () => ({ postgres: true, redis: true }), onServerError });

const ALL_SCOPES = Object.keys(SCOPE_DOCS);
const UUID = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10";

interface Op { method: string; path: string; url: string; scope: string; id: string }
const spec = await (await app.request("/openapi.json")).json();
const ops: Op[] = [];
for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
  for (const [method, op] of Object.entries<any>(item)) {
    ops.push({ method: method.toUpperCase(), path, url: path.replace(/\{[^}]+\}/g, UUID), scope: op["x-required-scope"], id: op.operationId });
  }
}
const send = (o: Op, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }, body: unknown = {}) =>
  app.request(o.url, { method: o.method, headers: { "content-type": "application/json", ...headers }, body: o.method === "GET" || o.method === "DELETE" ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.rateLimit.mockResolvedValue(true);
  resetPrincipal(ALL_SCOPES);
});

describe("spec-driven scope enforcement", () => {
  it("discovers a meaningful operation set and every scope is documented", () => {
    expect(ops.length).toBeGreaterThanOrEqual(25);
    for (const o of ops) expect(o.scope === "none" || o.scope in SCOPE_DOCS, `${o.id}: ${o.scope}`).toBe(true);
    const used = new Set(ops.map((o) => o.scope));
    for (const s of ["profile:read", "catalogue:read", "search:read", "leads:write", "messages:write", "billing:read"]) if (!SCOPE_DOCS[s as keyof typeof SCOPE_DOCS]) throw new Error(s);
    expect(used.size).toBeGreaterThan(8);
  });

  it.each(ops.map((o) => [`${o.method} ${o.path}`, o] as const))("%s: 401 without key, 403 without scope, passes auth with only its scope", async (_n, o) => {
    const anon = await send(o, {});
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Bearer");

    if (o.scope === "none") return;
    const lacking = ALL_SCOPES.filter((s) => s !== o.scope && !(o.scope.endsWith(":read") && s === o.scope.replace(":read", ":write")));
    resetPrincipal(lacking);
    const denied = await send(o);
    expect(denied.status).toBe(403);
    const b = await denied.json();
    expect(b.error.code).toBe("insufficient_scope");
    expect(b.error.message).toContain(o.scope);
    expect(denied.headers.get("www-authenticate")).toContain(`scope="${o.scope}"`);

    resetPrincipal([o.scope]);
    const ok = await send(o, undefined, {});
    expect([401, 403]).not.toContain(ok.status);
  });

  it("a :write scope implies its :read for GET operations (and not the reverse)", async () => {
    const reads = ops.filter((o) => o.scope.endsWith(":read") && o.method === "GET");
    for (const o of reads) {
      resetPrincipal([o.scope.replace(":read", ":write")]);
      expect([401, 403]).not.toContain((await send(o)).status);
    }
    const writes = ops.filter((o) => o.scope.endsWith(":write"));
    for (const o of writes) {
      resetPrincipal([o.scope.replace(":write", ":read")]);
      expect((await send(o)).status).toBe(403);
    }
  });

  it("business-bound operations refuse a key without a business (403 forbidden, not 500)", async () => {
    resetPrincipal(ALL_SCOPES, null);
    const bound = ["listSellerLeads", "listEnquiries", "getBalance", "createEnquiry", "listSellerListings"];
    for (const id of bound) {
      const o = ops.find((x) => x.id === id);
      if (!o) continue;
      const r = await send(o, undefined, { title: "500 kg steel sheets", requirement: "Need 500 kg SS304 sheets by month end." });
      expect(r.status, id).toBe(403);
      expect((await r.json()).error.code).toBe("forbidden");
    }
  });
});

describe("every registered /v1 route is documented (and vice versa)", () => {
  it("app.routes <-> openapi paths", () => {
    const registered = new Set(
      app.routes.filter((r) => r.path.startsWith("/v1/") && r.method !== "ALL").map((r) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, "{$1}")}`),
    );
    const documented = new Set(ops.map((o) => `${o.method} /v1${o.path.startsWith("/v1") ? o.path.slice(3) : o.path}`.replace(/\/v1\/v1/, "/v1")));
    expect([...registered].filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((d) => !registered.has(d))).toEqual([]);
  });
});

describe("validation (422) shape", () => {
  const find = (id: string) => ops.find((o) => o.id === id)!;
  const expect422 = async (r: Response) => {
    expect(r.status).toBe(422);
    const { error } = await r.json();
    expect(error).toMatchObject({ code: "validation", message: "Request validation failed" });
    expect(typeof error.requestId).toBe("string");
    expect(error.issues.length).toBeGreaterThan(0);
    for (const i of error.issues) expect(i).toEqual({ path: expect.any(String), message: expect.any(String) });
    return error;
  };
  it("bad query names the field", async () => {
    const e = await expect422(await app.request("/v1/enquiries?limit=0", auth()));
    expect(e.issues[0].path).toBe("limit");
    await expect422(await app.request("/v1/seller/leads?limit=101", auth()));
    await expect422(await app.request("/v1/seller/leads?limit=abc", auth()));
  });
  it("non-uuid path id is a 404 (never a 500)", async () => {
    const r = await app.request("/v1/enquiries/not-a-uuid", auth());
    expect(r.status).toBe(404);
  });
  it("bad body: missing fields, wrong types, malformed JSON", async () => {
    const o = find("createEnquiry");
    const e = await expect422(await send(o, undefined, { title: 1 }));
    expect(e.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["title", "requirement"]));
    const bad = await app.request(o.url, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400); // regression: hono's malformed-JSON HTTPException used to surface as 500
    expect((await bad.json()).error).toMatchObject({ code: "invalid_request" });
    await expect422(await send(find("sendMessage"), undefined, { body: "" }));
    await expect422(await send(find("submitListingReview"), undefined, { rating: 9, body: "x" }));
  });
});

describe("error envelope", () => {
  it.each(Object.entries(HTTP_STATUS))("DomainError %s -> HTTP %i with envelope + request id", async (code, status) => {
    m.getBuyerEnquiry.mockRejectedValueOnce(new DomainError(code as never, `boom ${code}`));
    const r = await app.request(`/v1/enquiries/${UUID}`, { headers: { authorization: `Bearer ${KEY}`, "x-request-id": "req-abcdefgh" } });
    expect(r.status).toBe(status);
    expect(r.headers.get("x-request-id")).toBe("req-abcdefgh");
    const b = await r.json();
    expect(b.error).toEqual({ code, message: `boom ${code}`, requestId: "req-abcdefgh" });
    if (code === "rate_limited") expect(r.headers.get("retry-after")).toBe("30");
  });
  it("unexpected errors are 500 with a generic message, reported once, never leaking internals", async () => {
    m.getBuyerEnquiry.mockRejectedValueOnce(new Error("secret db password in stack"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await app.request(`/v1/enquiries/${UUID}`, auth());
    spy.mockRestore();
    expect(r.status).toBe(500);
    const b = await r.json();
    expect(b.error).toMatchObject({ code: "internal", message: "Internal server error" });
    expect(JSON.stringify(b)).not.toContain("secret");
    expect(onServerError).toHaveBeenCalledTimes(1);
  });
  it("invalid incoming request ids are replaced", async () => {
    const r = await app.request("/health", { headers: { "x-request-id": "bad id!" } });
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("unknown route -> 404 envelope; root redirects to docs; docs render", async () => {
    const r = await app.request("/nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
    expect((await app.request("/")).status).toBe(302);
    expect(await (await app.request("/docs")).text()).toContain("<");
  });
  it("health degrades to 503; health thrower is tolerated", async () => {
    const bad = createApp({ health: async () => ({ postgres: true, redis: false }) });
    expect((await bad.request("/health")).status).toBe(503);
    const thrower = createApp({ health: async () => { throw new Error("x"); } });
    const r = await thrower.request("/health");
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: "degraded", postgres: false });
  });
  it("security headers present and CORS is deny-by-default", async () => {
    const r = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("auth edge cases + rate limiting", () => {
  const get = (h: Record<string, string>) => app.request("/v1/me", { headers: h });
  it("rejects non-bearer, empty, malformed (no ck_) and extra-token headers with WWW-Authenticate", async () => {
    for (const h of ["", "Basic abc", "Bearer", `Bearer ${KEY} extra`, "Bearer sk_live_nope"]) {
      const r = await get(h ? { authorization: h } : {});
      expect(r.status, h).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/^Bearer realm="cnote-api", error="invalid_(request|token)"/);
    }
  });
  it("scheme is case-insensitive", async () => {
    expect((await get({ authorization: `bearer ${KEY}` })).status).not.toBe(401);
  });
  it("429 carries Retry-After in 1..60 and the limit header; limiter keyed per key id", async () => {
    m.rateLimit.mockResolvedValueOnce(false);
    const r = await get({ authorization: `Bearer ${KEY}` });
    expect(r.status).toBe(429);
    const ra = Number(r.headers.get("retry-after"));
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
    expect(r.headers.get("x-ratelimit-limit")).toBe("120");
    expect((await r.json()).error.code).toBe("rate_limited");
    expect(m.rateLimit).toHaveBeenCalledWith("api:k1", 120, 60);
  });
  it("fails open when the limiter (redis) throws", async () => {
    m.rateLimit.mockRejectedValueOnce(new Error("redis down"));
    expect((await get({ authorization: `Bearer ${KEY}` })).status).not.toBe(429);
  });
  it("OPTIONS preflight needs no key", async () => {
    const r = await app.request("/v1/me", { method: "OPTIONS", headers: { origin: "https://x.example", "access-control-request-method": "GET" } });
    expect(r.status).toBeLessThan(300);
  });
  it("a bad key never reaches the limiter", async () => {
    await get({ authorization: "Bearer ck_live_wrong" });
    expect(m.rateLimit).not.toHaveBeenCalled();
  });
});

describe("pagination", () => {
  it("cursor walk over any list returns every item once, in order, honouring limit", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 60 }), fc.integer({ min: 1, max: 25 }), (all, limit) => {
        const seen: number[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const p = paginate(all, cursor, limit);
          expect(p.items.length).toBeLessThanOrEqual(limit);
          seen.push(...p.items);
          cursor = p.nextCursor ?? undefined;
          pages++;
        } while (cursor && pages < 100);
        expect(seen).toEqual(all);
        expect(pages).toBe(Math.max(1, Math.ceil(all.length / limit)));
      }),
    );
  });
  it("last page has nextCursor null; garbage / negative cursors are validation errors", async () => {
    expect(paginate([1, 2, 3], undefined, 3).nextCursor).toBeNull();
    for (const c of ["!!!", Buffer.from(" 5").toString("base64url"), Buffer.from("1e3").toString("base64url"), Buffer.from("-5").toString("base64url"), Buffer.from("1.5").toString("base64url")]) {
      expect(() => paginate([1], c, 1)).toThrowError(/Invalid cursor/);
    }
    m.listBuyerEnquiries.mockResolvedValue([]);
    const r = await app.request("/v1/enquiries?cursor=%21%21", auth());
    expect(r.status).toBe(422);
  });
  it("REST list returns items + nextCursor and pages through", async () => {
    m.listBuyerEnquiries.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const p1 = await (await app.request("/v1/enquiries?limit=2", auth())).json();
    expect(p1.items.map((i: any) => i.id)).toEqual(["a", "b"]);
    expect(p1.items[0].currency).toBe("INR");
    const p2 = await (await app.request(`/v1/enquiries?limit=2&cursor=${p1.nextCursor}`, auth())).json();
    expect(p2.items.map((i: any) => i.id)).toEqual(["c"]);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("business isolation (acts only as the key's identity)", () => {
  it("REST: a businessId smuggled in the body/query is ignored; domain is called with the key's business", async () => {
    m.createEnquiry.mockResolvedValue({ id: "e", matches: [] });
    const o = ops.find((x) => x.id === "createEnquiry")!;
    await send(o, undefined, { title: "500 kg steel sheets", requirement: "Need 500 kg SS304 sheets by month end.", businessId: "b-evil", personId: "p-evil" });
    expect(m.createEnquiry.mock.calls[0]![0]).toEqual({ personId: "p1", businessId: "b1" });
    expect(JSON.stringify(m.createEnquiry.mock.calls[0]![1])).not.toContain("evil");
  });
  it("lead accept/decline check the lead belongs to the key's business before acting", async () => {
    m.getSellerLead.mockResolvedValue(null);
    const acc = await app.request(`/v1/seller/leads/${UUID}/accept`, { method: "POST", headers: { authorization: `Bearer ${KEY}` } });
    expect(acc.status).toBe(404);
    expect(m.getSellerLead).toHaveBeenCalledWith("b1", UUID);
    expect(m.acceptLead).not.toHaveBeenCalled();
    const dec = await app.request(`/v1/seller/leads/${UUID}/decline`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: "{}" });
    expect(dec.status).toBe(404);
    expect(m.declineLead).not.toHaveBeenCalled();
  });
  it("non-public listings are invisible (draft / unapproved -> 404)", async () => {
    for (const l of [{ status: "draft", moderationStatus: "approved" }, { status: "published", moderationStatus: "pending" }, null]) {
      m.getListing.mockResolvedValueOnce(l);
      expect((await app.request(`/v1/listings/${UUID}`, auth())).status).toBe(404);
    }
  });
});

describe("MCP", () => {
  const rpc = (method: string, params: unknown = {}) => jsonReq({ jsonrpc: "2.0", id: 1, method, params });
  const scopeSubset = fc.subarray(ALL_SCOPES);

  it("tools/list is exactly the tools the scopes allow, for random scope subsets", async () => {
    await fc.assert(
      fc.asyncProperty(scopeSubset, async (scopes) => {
        resetPrincipal(scopes);
        const r = await app.request("/mcp", rpc("tools/list"));
        const body = await r.json();
        // A key with no tool scope has no tools capability at all; the SDK answers "method not found".
        if (!scopes.some((s) => ALL_TOOLS.some((t) => hasScope({ scopes: [s] } as never, t.scope)))) {
          expect(body.error).toBeTruthy();
          return;
        }
        const names = body.result.tools.map((t: { name: string }) => t.name).sort();
        const expected = ALL_TOOLS.filter((t) => hasScope({ scopes } as never, t.scope)).map((t) => t.name).sort();
        expect(names).toEqual(expected);
      }),
      { numRuns: 25 },
    );
  });
  it("every tool is scoped, uniquely named, and every scope-holding key can call it (no unknown-tool)", () => {
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(ALL_TOOLS.length);
    for (const t of ALL_TOOLS) expect(t.scope in SCOPE_DOCS).toBe(true);
  });
  it("calling a tool outside the key's scopes is refused for every tool", async () => {
    for (const t of ALL_TOOLS) {
      resetPrincipal(ALL_SCOPES.filter((s) => s !== t.scope && s !== t.scope.replace(":read", ":write")));
      const b = await (await app.request("/mcp", rpc("tools/call", { name: t.name, arguments: {} }))).json();
      expect(b.error ?? b.result?.isError, t.name).toBeTruthy();
    }
    expect(m.acceptLead).not.toHaveBeenCalled();
  });
  it("DomainErrors from the domain become isError results carrying code + message (not protocol errors)", async () => {
    m.getSellerLead.mockResolvedValue({ id: "m1" });
    for (const code of ["insufficient_credits", "conflict", "not_found", "forbidden"] as const) {
      m.acceptLead.mockRejectedValueOnce(new DomainError(code, `nope ${code}`));
      const b = await (await app.request("/mcp", rpc("tools/call", { name: "accept_lead", arguments: { matchId: UUID } }))).json();
      expect(b.error).toBeUndefined();
      expect(b.result.isError).toBe(true);
      expect(JSON.parse(b.result.content[0].text)).toEqual({ error: { code, message: `nope ${code}` } });
    }
  });
  it("unexpected tool errors are masked with the request id", async () => {
    m.getSellerLead.mockRejectedValueOnce(new Error("pg password leaked"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const b = await (await app.request("/mcp", rpc("tools/call", { name: "accept_lead", arguments: { matchId: UUID } }))).json();
    spy.mockRestore();
    expect(b.result.isError).toBe(true);
    expect(b.result.content[0].text).not.toContain("leaked");
    expect(b.result.content[0].text).toContain("Internal error");
  });
  it("tools act only as the key's business, never a caller-supplied one", async () => {
    m.getSellerLead.mockResolvedValue({ id: "m1" });
    m.acceptLead.mockResolvedValue({ id: "m1", enquiry: {} });
    const b = await (await app.request("/mcp", rpc("tools/call", { name: "accept_lead", arguments: { matchId: UUID, businessId: "b-evil" } }))).json();
    expect(b.result.isError).toBeFalsy();
    expect(m.getSellerLead).toHaveBeenCalledWith("b1", UUID);
    expect(m.acceptLead).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, UUID);
  });
  it("key with no business: business tools return isError forbidden", async () => {
    resetPrincipal(ALL_SCOPES, null);
    for (const [name, args] of [["list_leads", {}], ["get_credit_balance", {}], ["list_my_enquiries", {}], ["send_message", { conversationId: UUID, body: "hi" }]] as const) {
      const b = await (await app.request("/mcp", rpc("tools/call", { name, arguments: args }))).json();
      expect(b.result.isError, name).toBe(true);
      expect(b.result.content[0].text).toContain("forbidden");
    }
  });
  it("tool input validation surfaces as an error, not a success", async () => {
    const b = await (await app.request("/mcp", rpc("tools/call", { name: "search_products", arguments: { limit: 5 } }))).json();
    expect(b.error ?? b.result.isError).toBeTruthy();
  });
  it("read/list tools return structuredContent (arrays wrapped in items)", async () => {
    m.listSellerLeads.mockResolvedValue([]);
    const b = await (await app.request("/mcp", rpc("tools/call", { name: "list_leads", arguments: {} }))).json();
    expect(b.result.structuredContent).toEqual({ items: [], nextCursor: null });
    m.getBalance.mockResolvedValue(3);
    m.getActiveSubscription.mockResolvedValue(null);
    const c = await (await app.request("/mcp", rpc("tools/call", { name: "get_credit_balance", arguments: {} }))).json();
    expect(c.result.structuredContent).toEqual({ credits: 3, subscription: null });
  });
  it("MCP is rate limited and authenticated like REST", async () => {
    m.rateLimit.mockResolvedValueOnce(false);
    const r = await app.request("/mcp", rpc("tools/list"));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
// Happy paths through ops: mapping (currency, seller-only field stripping) and the identity passed down.
// ---------------------------------------------------------------------------------------------
const A = { personId: "p1", businessId: "b1" };
const listingRow = { id: UUID, status: "published", moderationStatus: "approved", moderationReason: null, images: [{ id: "i" }], title: "Bolt", pricePaise: 100 };
const call = (o: string, init: { body?: unknown; path?: Record<string, string>; query?: string } = {}) => {
  const op = ops.find((x) => x.id === o)!;
  let url = op.path.replace(/\{(\w+)\}/g, (_m, k) => init.path?.[k] ?? UUID) + (init.query ? `?${init.query}` : "");
  return app.request(`/v1${url.startsWith("/v1") ? url.slice(3) : url}`, {
    method: op.method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
};

describe("REST happy paths", () => {
  it("public listing hides seller-only fields; seller listing keeps status but not images", async () => {
    m.getListing.mockResolvedValue(listingRow);
    const pub = await (await call("getListing")).json();
    expect(pub).toMatchObject({ id: UUID, currency: "INR" });
    for (const k of ["status", "moderationStatus", "moderationReason", "images"]) expect(pub).not.toHaveProperty(k);
    m.listSellerListings.mockResolvedValue([listingRow]);
    const mine = await (await call("listSellerListings")).json();
    expect(mine.items[0]).toMatchObject({ status: "published", moderationStatus: "approved", currency: "INR" });
    expect(mine.items[0]).not.toHaveProperty("images");
    expect(m.listSellerListings).toHaveBeenCalledWith("b1");
  });

  it("listings always carry stock + variants on the wire, with defaults for older rows", async () => {
    m.getListing.mockResolvedValue(listingRow);
    expect(await (await call("getListing")).json()).toMatchObject({ availability: "in_stock", availableQty: null, stockUpdatedAt: null, variantAxes: [], variants: [] });
    const variant = { id: UUID, sku: "B-M", axisValues: { size: "M" }, pricePaise: null, priceTiers: [], moq: null, availability: "made_to_order", availableQty: null, leadTimeDays: 9, imageId: null, sortOrder: 0 };
    m.getListing.mockResolvedValue({ ...listingRow, availability: "made_to_order", variantAxes: [{ key: "size", label: "Size" }], variants: [variant] });
    expect(await (await call("getListing")).json()).toMatchObject({ availability: "made_to_order", variantAxes: [{ key: "size", label: "Size" }], variants: [variant] });
  });

  it("stock PATCH and variants PUT act as the key's business (listings:write)", async () => {
    m.updateListingStock.mockResolvedValue({ ...listingRow, availability: "out_of_stock" });
    const r = await call("updateSellerListingStock", { body: { availability: "out_of_stock", variants: [{ sku: "B-M", availability: "in_stock" }] } });
    expect(r.status).toBe(200);
    expect((await r.json()).availability).toBe("out_of_stock");
    expect(m.updateListingStock).toHaveBeenCalledWith("b1", UUID, { availability: "out_of_stock", variants: [{ sku: "B-M", availability: "in_stock" }] });
    expect((await call("updateSellerListingStock", { body: { availability: "gone" } })).status).toBe(422);
    m.updateListingStock.mockRejectedValueOnce(new DomainError("validation", "Stock: lead time (days) is required for made-to-order"));
    expect((await call("updateSellerListingStock", { body: { availability: "made_to_order" } })).status).toBe(422);

    m.setListingVariants.mockResolvedValue([]);
    m.getListing.mockResolvedValue({ ...listingRow, variants: [] });
    const put = await call("setSellerListingVariants", { body: { variants: [{ sku: "B-M", axisValues: { size: "M" }, pricePaise: 1500 }] } });
    expect(put.status).toBe(200);
    expect(m.setListingVariants).toHaveBeenCalledWith("b1", UUID, [{ sku: "B-M", axisValues: { size: "M" }, pricePaise: 1500 }]);
    expect((await call("setSellerListingVariants", { body: { variants: [{ sku: "bad sku", axisValues: {} }] } })).status).toBe(422);
    expect((await call("setSellerListingVariants", { body: {} })).status).toBe(422);
  });

  it("search passes in_stock and variant filters through to the search module and returns facets", async () => {
    m.searchListings.mockResolvedValue({ hits: [], facets: { variant: [{ key: "size:m", count: 2 }] } } as never);
    const r = await (await call("searchListings", { query: "q=bolt&in_stock=true&variant=size:M,size:l,colour:Red,junk" })).json();
    expect(m.searchListings).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { inStockOnly: true, variantOptions: { size: ["M", "l"], colour: ["Red"] } } }));
    expect(r.facets.variant).toEqual([{ key: "size:m", count: 2 }]);
    await call("searchListings", { query: "q=bolt" });
    expect(((m.searchListings.mock.calls.at(-1) as unknown as [{ filters?: unknown }])[0]).filters).toBeUndefined();
  });

  it("categories hide prohibited ones and internal fields", async () => {
    m.listCategories.mockResolvedValue([
      { id: "c1", slug: "a", name: "A", leadCap: 3, prohibited: false, attributeSchema: { fields: [] } },
      { id: "c2", slug: "bad", name: "Bad", leadCap: 3, prohibited: true, attributeSchema: { fields: [] } },
    ]);
    const b = await (await call("listCategories")).json();
    expect(b.items.map((c: any) => c.slug)).toEqual(["a"]);
    expect(b.items[0]).not.toHaveProperty("leadCap");
    m.getCategoryBySlug.mockResolvedValueOnce({ id: "c2", slug: "bad", prohibited: true });
    expect((await call("getCategory", { path: { slug: "bad" } })).status).toBe(404);
    m.getCategoryBySlug.mockResolvedValueOnce(null);
    expect((await call("getCategory", { path: { slug: "zz" } })).status).toBe(404);
  });

  it("seller listing create/patch/publish/archive act as the key's business; unknown category slug -> 422", async () => {
    m.getCategoryBySlug.mockResolvedValue({ id: "cat1", slug: "s" });
    m.createListing.mockResolvedValue(listingRow);
    const body = { categorySlug: "s", title: "Hex bolt M8", description: "d" };
    const r = await call("createSellerListing", { body });
    expect(r.status).toBe(201);
    expect(m.createListing.mock.calls[0]![0]).toBe("b1");
    expect(m.createListing.mock.calls[0]![1]).toMatchObject({ categoryId: "cat1", title: "Hex bolt M8" });
    m.updateListing.mockResolvedValue(listingRow);
    expect((await call("updateSellerListing", { body: { title: "New title", categorySlug: "s" } })).status).toBe(200);
    expect(m.updateListing).toHaveBeenCalledWith("b1", UUID, expect.objectContaining({ categoryId: "cat1" }));
    m.publishListing.mockResolvedValue(listingRow);
    expect((await call("publishSellerListing")).status).toBe(200);
    expect(m.publishListing).toHaveBeenCalledWith("b1", UUID);
    m.archiveListing.mockResolvedValue(undefined);
    expect(await (await call("archiveSellerListing")).json()).toEqual({ ok: true });
    m.getCategoryBySlug.mockResolvedValue(null);
    const bad = await call("createSellerListing", { body });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.message).toContain("Unknown category slug");
    const none = await call("createSellerListing", { body: { title: "Hex bolt M8", description: "d" } });
    expect(none.status).toBe(422);
  });

  it("leads: list adds currency; accept/decline pass the key identity", async () => {
    m.listSellerLeads.mockResolvedValue([{ id: "m1", enquiry: { id: "e" } }]);
    const l = await (await call("listSellerLeads")).json();
    expect(l.items[0].enquiry.currency).toBe("INR");
    m.getSellerLead.mockResolvedValue({ id: "m1" });
    m.acceptLead.mockResolvedValue({ id: "m1", enquiry: { id: "e" } });
    expect((await call("acceptSellerLead")).status).toBe(200);
    expect(m.acceptLead).toHaveBeenCalledWith(A, UUID);
    const d = await call("declineSellerLead", { body: { reason: "not my category" } });
    expect(d.status).toBe(200);
    expect(m.declineLead).toHaveBeenCalledWith(A, UUID, "not my category");
  });

  it("insufficient credits on accept is 402", async () => {
    m.getSellerLead.mockResolvedValue({ id: "m1" });
    m.acceptLead.mockRejectedValue(new DomainError("insufficient_credits", "no credits"));
    const r = await call("acceptSellerLead");
    expect(r.status).toBe(402);
    expect((await r.json()).error.code).toBe("insufficient_credits");
  });

  it("balance, me, seller profile", async () => {
    m.getBalance.mockResolvedValue(7);
    m.getActiveSubscription.mockResolvedValue({ planCode: "starter", status: "active", periodEnd: "2026-10-01T00:00:00.000Z", extra: 1 });
    expect(await (await call("getCreditBalance")).json()).toEqual({ credits: 7, subscription: { planCode: "starter", status: "active", periodEnd: "2026-10-01T00:00:00.000Z" } });
    m.getTrustProfiles.mockResolvedValue(new Map());
    expect((await call("getSeller")).status).toBe(404);
    m.getTrustProfiles.mockResolvedValue(new Map([[UUID, { businessId: UUID, name: "S", city: null, state: null, pincode: null, verificationTier: 1, trustScore: 50, badgeActive: false, languages: [] }]]));
    expect((await call("getSeller")).status).toBe(200);
    m.getPersonSummaries.mockResolvedValue(new Map([["p1", { name: "Pat", email: "p***@x.com" }]]));
    m.getPersonBusinesses.mockResolvedValue([{ businessId: "b1", name: "B", role: "owner", isSeller: true, isBuyer: false, verificationTier: 1, badgeActive: false }]);
    m.getTrustProfiles.mockResolvedValue(new Map());
    const me = await (await call("getMe")).json();
    expect(me).toMatchObject({ personId: "p1", keyId: "k1", businessId: "b1", business: null, person: { id: "p1", name: "Pat" } });
    expect(me.businesses[0].role).toBe("owner");
    resetPrincipal(ALL_SCOPES, null);
    m.getTrustProfiles.mockClear();
    expect((await call("getMe")).status).toBe(200);
    expect(m.getTrustProfiles).not.toHaveBeenCalled();
  });

  it("enquiry read, conversation, message, quote and deal report use the key's identity", async () => {
    m.getBuyerEnquiry.mockResolvedValue({ id: "e1", matches: [] });
    expect((await (await call("getEnquiry")).json()).currency).toBe("INR");
    m.getBuyerEnquiry.mockResolvedValue(null);
    expect((await call("getEnquiry")).status).toBe(404);
    m.getConversation.mockResolvedValue({ id: "c", quotes: [{ id: "q" }], messages: [] });
    expect((await (await call("getConversation")).json()).quotes[0].currency).toBe("INR");
    m.getConversation.mockResolvedValue(null);
    expect((await call("getConversation")).status).toBe(404);
    expect((await call("sendMessage", { body: { body: "hello" } })).status).toBe(201);
    expect(m.sendMessage).toHaveBeenCalledWith(A, UUID, "hello");
    const q = { pricePaise: 20500, quantity: 5, unit: "kg" };
    expect((await call("sendQuote", { body: q })).status).toBe(201);
    expect(m.sendQuote).toHaveBeenCalledWith(A, UUID, expect.objectContaining(q));
    expect((await call("reportDeal", { body: { outcome: "won", valuePaise: 100 } })).status).toBe(201);
    expect(m.reportDeal).toHaveBeenCalledWith(A, UUID, "won", 100);
  });

  it("quotes are seller-only: the domain's forbidden becomes 403", async () => {
    m.sendQuote.mockRejectedValueOnce(new DomainError("forbidden", "Only the seller can quote"));
    const r = await call("sendQuote", { body: { pricePaise: 1, quantity: 1, unit: "kg" } });
    expect(r.status).toBe(403);
  });

  it("wishlist: person-scoped; add refuses non-public listings; remove passes ids in order", async () => {
    m.listLists.mockResolvedValue([{ id: "w", name: "Default", itemCount: 0, isDefault: true }]);
    expect((await call("listWishlists")).status).toBe(200);
    expect(m.listLists).toHaveBeenCalledWith("p1");
    m.getList.mockResolvedValue({ id: "w", name: "D", items: [{ listingId: "l", listing: listingRow }, { listingId: "gone", listing: null }] });
    const w = await (await call("getWishlist")).json();
    expect(w.items[0].listing).not.toHaveProperty("moderationStatus");
    expect(w.items[1].listing).toBeNull();
    expect(w.items[0].currency).toBe("INR");
    m.getListing.mockResolvedValueOnce({ ...listingRow, status: "draft" });
    expect((await call("addWishlistItem", { body: { listingId: UUID } })).status).toBe(404);
    expect(m.addItem).not.toHaveBeenCalled();
    m.getListing.mockResolvedValue(listingRow);
    m.addItem.mockResolvedValue({ added: true, listId: "w" });
    expect((await call("addWishlistItem", { body: { listingId: UUID } })).status).toBe(201);
    expect(m.addItem).toHaveBeenCalledWith("p1", UUID, UUID);
    m.removeItem.mockResolvedValue({ removed: true });
    const other = "1b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10";
    await call("removeWishlistItem", { path: { id: UUID, listingId: other } });
    expect(m.removeItem).toHaveBeenCalledWith("p1", UUID, other);
  });

  it("reviews: only for public listings; submit acts as the key's person+business", async () => {
    m.getListing.mockResolvedValue(listingRow);
    m.listApprovedReviews.mockResolvedValue({ items: [], nextCursor: null });
    m.getRatingSummary.mockResolvedValue({ average: 0, count: 0, distribution: {} });
    const r = await call("listListingReviews", { query: "sort=helpful&limit=5" });
    expect(r.status).toBe(200);
    expect(m.listApprovedReviews).toHaveBeenCalledWith(UUID, { cursor: undefined, limit: 5, sort: "helpful" });
    expect((await call("listListingReviews", { query: "sort=bogus" })).status).toBe(422);
    m.submitReview.mockResolvedValue({ id: "r", status: "pending" });
    const s = await call("submitListingReview", { body: { rating: 5, body: "Great supplier, on time delivery." } });
    expect(s.status).toBe(201);
    expect(m.submitReview).toHaveBeenCalledWith(A, UUID, expect.objectContaining({ rating: 5, language: expect.any(String) }));
    m.getListing.mockResolvedValue(null);
    expect((await call("listListingReviews")).status).toBe(404);
    expect((await call("submitListingReview", { body: { rating: 5, body: "Great supplier, on time delivery." } })).status).toBe(404);
  });
});

describe("MCP tools happy paths", () => {
  const callTool = async (name: string, args: Record<string, unknown> = {}) =>
    (await (await app.request("/mcp", jsonReq({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }))).json()).result;
  const cat = { id: "c1", slug: "s", name: "S", leadCap: 3, prohibited: false, attributeSchema: { fields: [] } };

  it("every tool runs against its domain call with the key's identity and returns structured output", async () => {
    m.getListing.mockResolvedValue(listingRow);
    m.getTrustProfiles.mockResolvedValue(new Map([[UUID, { businessId: UUID }]]));
    m.listCategories.mockResolvedValue([cat]);
    m.getBuyerEnquiry.mockResolvedValue({ id: "e", matches: [] });
    m.createEnquiry.mockResolvedValue({ id: "e", matches: [] });
    m.listBuyerEnquiries.mockResolvedValue([]);
    m.listSellerLeads.mockResolvedValue([]);
    m.getSellerLead.mockResolvedValue({ id: "m" });
    m.acceptLead.mockResolvedValue({ id: "m", enquiry: {} });
    m.listSellerListings.mockResolvedValue([]);
    m.getCategoryBySlug.mockResolvedValue(cat);
    m.createListing.mockResolvedValue(listingRow);
    m.publishListing.mockResolvedValue(listingRow);
    m.updateListingStock.mockResolvedValue(listingRow);
    m.setListingVariants.mockResolvedValue([]);
    m.listLists.mockResolvedValue([]);
    m.addItem.mockResolvedValue({ added: true, listId: UUID });
    m.listApprovedReviews.mockResolvedValue({ items: [], nextCursor: null });
    m.getRatingSummary.mockResolvedValue({});
    m.submitReview.mockResolvedValue({ id: "r", status: "pending" });
    m.getBalance.mockResolvedValue(2);
    m.getActiveSubscription.mockResolvedValue(null);
    const args: Record<string, Record<string, unknown>> = {
      search_products: { q: "bolt" }, get_listing: { listingId: UUID }, list_categories: {}, get_seller_profile: { sellerId: UUID },
      create_enquiry: { title: "500 kg steel", requirement: "Need SS304 sheets, 500kg.", categorySlug: "s" },
      list_my_enquiries: {}, get_enquiry: { enquiryId: UUID }, list_leads: {}, accept_lead: { matchId: UUID },
      decline_lead: { matchId: UUID, reason: "no" }, list_my_listings: {},
      create_listing: { categorySlug: "s", title: "Hex bolt", description: "d" }, publish_listing: { listingId: UUID },
      update_listing_stock: { listingId: UUID, availability: "out_of_stock" },
      set_listing_variants: { listingId: UUID, variants: [{ sku: "A", axisValues: { size: "M" } }] },
      send_message: { conversationId: UUID, body: "hi" }, send_quote: { conversationId: UUID, pricePaise: 5, quantity: 2, unit: "kg" },
      list_wishlists: {}, add_to_wishlist: { wishlistId: UUID, listingId: UUID }, list_reviews: { listingId: UUID },
      submit_review: { listingId: UUID, rating: 4, body: "Solid quality, prompt delivery." }, get_credit_balance: {},
    };
    expect(Object.keys(args).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of TOOLS) {
      const res = await callTool(t.name, args[t.name]);
      expect(res.isError, `${t.name}: ${res.content?.[0]?.text}`).toBeFalsy();
      expect(res.structuredContent, t.name).toBeTruthy();
    }
    expect(m.createEnquiry).toHaveBeenCalledWith(A, expect.objectContaining({ language: "en" }), { ip: null, userAgent: null });
    expect(m.declineLead).toHaveBeenCalledWith(A, UUID, "no");
    expect(m.sendQuote).toHaveBeenCalledWith(A, UUID, { pricePaise: 5, quantity: 2, unit: "kg" });
    expect(m.submitReview).toHaveBeenCalledWith(A, UUID, expect.objectContaining({ rating: 4, language: "en" }));
  });
});
