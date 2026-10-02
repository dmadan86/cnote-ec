import { ServiceClient, signServiceToken } from "@cnote/ai/service-client";
import { DomainError } from "@cnote/core";
import { searchListings, suggest } from "@cnote/search";
import { remoteSearch, remoteSuggest } from "@cnote/search/remote";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/env";
import { buildOpenApi } from "../src/openapi";

const SECRET = "search-service-test-secret-0123456789ab";
const cfg = (over = {}) => ({ port: 0, tokenSecret: SECRET, maxInflight: 8, ...over });
const token = (o: Partial<Parameters<typeof signServiceToken>[0]> = {}) => signServiceToken({ secret: SECRET, audience: "search-service", issuer: "web", ...o });
const auth = { authorization: `Bearer ${token()}` };
const page = { hits: [], tookMs: 2 };
const make = (over: Parameters<typeof createApp>[0] = {}) => createApp({ config: cfg(), log: () => {}, env: {}, search: async () => page as never, suggest: async () => ["boxes"], ...over });
const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = auth) =>
  app.request("/v1/search", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("probes and docs", () => {
  it("health is open; ready probes dependencies and config", async () => {
    const app = make({ probes: { postgres: async () => 1, redis: async () => "PONG" } });
    expect((await app.request("/health")).status).toBe(200);
    // anonymous: status only (no backend name, no problems list); a valid service token adds the details
    expect(await (await app.request("/ready")).json()).toEqual({ status: "ready" });
    expect(await (await app.request("/ready", { headers: auth })).json()).toEqual({ status: "ready", backend: "postgres" });
    const bad = make({ config: cfg({ tokenSecret: "" }), env: { SEARCH_BACKEND: "opensearch" }, probes: { postgres: async () => { throw new Error("down"); }, redis: async () => 1 } });
    const r = await bad.request("/ready");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: "not_ready" });
    const down = make({ probes: { postgres: async () => { throw new Error("down"); }, redis: async () => 1 } });
    const rd = await down.request("/ready", { headers: auth });
    expect(rd.status).toBe(503);
    expect((await rd.json() as any).problems).toEqual(["postgres unreachable"]);
  });
  it("serves OpenAPI and 404s unknown routes", async () => {
    const spec = (await (await make().request("/openapi.json")).json()) as any;
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/search", "/v1/suggest"]));
    expect(buildOpenApi("2.0.0").info.version).toBe("2.0.0");
    expect((await make().request("/x")).status).toBe(404);
  });
  it("loads config with defaults and refuses SEARCH_TRANSPORT=http", () => {
    expect(loadConfig({})).toEqual({ port: 3006, tokenSecret: "", maxInflight: 128 });
    expect(loadConfig({ PORT: "1", SEARCH_SERVICE_TOKEN_SECRET: "s", SEARCH_SERVICE_MAX_INFLIGHT: "3" })).toEqual({ port: 1, tokenSecret: "s", maxInflight: 3 });
    expect(() => createApp({ config: cfg(), env: { SEARCH_TRANSPORT: "http" } })).toThrow(/inproc/);
  });
});

describe("auth", () => {
  it("rejects bad tokens (wrong audience, key, expiry, none) and accepts rotated keys", async () => {
    const app = make();
    const bad = [
      undefined, "Bearer x", `Bearer ${token({ audience: "ai-service" })}`, `Bearer ${signServiceToken({ secret: "nope-nope-nope-nope-nope-nope-nope", audience: "search-service", issuer: "w" })}`,
      `Bearer ${token({ nowMs: Date.now() - 3_600_000 })}`,
    ];
    for (const h of bad) {
      const r = await post(app, { q: "boxes" }, h ? { authorization: h } : {});
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain("invalid_token");
    }
    const old = "previous-previous-previous-previous-key";
    const rotating = make({ config: cfg({ tokenSecret: `${SECRET},${old}` }) });
    expect((await post(rotating, { q: "b" }, { authorization: `Bearer ${signServiceToken({ secret: old, audience: "search-service", issuer: "w" })}` })).status).toBe(200);
    expect((await post(make({ config: cfg({ tokenSecret: "" }) }), { q: "b" })).status).toBe(401);
  });
  it("logs the caller and status, generating or echoing the request id", async () => {
    const lines: string[] = [];
    const app = make({ log: (l) => lines.push(l) });
    const r = await post(app, { q: "boxes" }, { ...auth, "x-request-id": "req-abcdefgh" });
    expect(r.headers.get("x-request-id")).toBe("req-abcdefgh");
    expect(JSON.parse(lines[0]!)).toMatchObject({ svc: "search-service", caller: "web", status: 200 });
    expect((await post(app, { q: "b" }, { ...auth, "x-request-id": "??" })).headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("routes", () => {
  it("search passes the JSON body through and returns the page", async () => {
    const search = vi.fn(async () => ({ hits: [], tookMs: 5, nextCursor: null }) as never);
    const r = await post(make({ search }), { q: "boxes", limit: 5 });
    expect(await r.json()).toEqual({ hits: [], tookMs: 5, nextCursor: null });
    expect(search).toHaveBeenCalledWith({ q: "boxes", limit: 5 });
    for (const bad of ["nope", "[]", "null"]) expect((await post(make(), bad)).status).toBe(422);
  });
  it("maps zod, domain and unexpected errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await post(make({ search: async () => { z.object({ limit: z.number() }).parse({ limit: "x" }); return page as never; } }), { q: "x" });
    expect(a.status).toBe(422);
    expect(((await a.json()) as any).error.message).toContain("limit:");
    const b = await post(make({ search: async () => { throw new DomainError("not_found", "nope"); } }), { q: "x" });
    expect(b.status).toBe(404);
    const c = await post(make({ search: async () => { throw new Error("db password leaked"); } }), { q: "x" });
    expect(c.status).toBe(500);
    expect(JSON.stringify(await c.json())).not.toContain("password");
    err.mockRestore();
  });
  it("suggest parses prefix and limit", async () => {
    const s = vi.fn(async () => ["boxes", "bags"]);
    const app = make({ suggest: s });
    const r = await app.request("/v1/suggest?prefix=bo&limit=3", { headers: auth });
    expect(await r.json()).toEqual({ suggestions: ["boxes", "bags"] });
    expect(s).toHaveBeenLastCalledWith("bo", 3);
    await app.request("/v1/suggest", { headers: auth });
    expect(s).toHaveBeenLastCalledWith("", 8);
    await app.request("/v1/suggest?prefix=a&limit=zzz", { headers: auth });
    expect(s).toHaveBeenLastCalledWith("a", 8);
    expect((await app.request("/v1/suggest")).status).toBe(401);
  });
  it("sheds load beyond maxInflight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = make({ config: cfg({ maxInflight: 1 }), search: async () => { await gate; return page as never; } });
    const first = post(app, { q: "a" });
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(app, { q: "b" });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    expect((await app.request("/ready")).status).toBe(503);
    release();
    expect((await first).status).toBe(200);
  });
});

describe("contract: in-process === over HTTP (real search against the test database)", () => {
  const app = createApp({ config: cfg(), log: () => {}, env: {} });
  const client = new ServiceClient({
    name: "search-service", baseUrl: "http://search.test", audience: "search-service", issuer: "contract", secret: SECRET, retries: 0,
    fetchImpl: (async (url: string, init: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch,
  });
  const strip = (r: object) => { const { tookMs: _t, ...rest } = JSON.parse(JSON.stringify(r)); return rest; };

  it("search returns the same hits, ordering and cursor", async () => {
    for (const q of ["packaging boxes", "zzzz-no-such-product-qqq", "t shirts manufacturers in pune"]) {
      const local = await searchListings({ q, limit: 10 });
      const remote = await remoteSearch(client, { q, limit: 10 }, null);
      expect(strip(remote)).toEqual(strip(local));
    }
  });
  it("suggest returns the same suggestions", async () => {
    for (const p of ["", "pack", "t sh"]) expect(await remoteSuggest(client, p, 8, null)).toEqual(await suggest(p, 8));
  });
  it("invalid queries are rejected (422) rather than falling back", async () => {
    await expect(remoteSearch(client, { q: "x".repeat(501) }, async () => page as never)).rejects.toMatchObject({ status: 422 });
  });
});
