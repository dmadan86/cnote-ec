import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceClient, ServiceRejectedError, ServiceUnavailableError, verifyServiceToken } from "@cnote/ai/service-client";
import { searchListings, suggest, EXAMPLE_QUERIES } from "../src";
import {
  SEARCH_SERVICE_AUDIENCE, remoteSearch, remoteSuggest, resetSharedSearchServiceClientForTests, searchFallbackEnabled, searchServiceClientFromEnv, searchTransport,
  sharedSearchServiceClient,
} from "../src/remote";

const SECRET = "search-remote-secret-0123456789abcdef";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetchImpl: typeof fetch, retries = 0) =>
  new ServiceClient({ name: "search-service", baseUrl: "http://search", audience: SEARCH_SERVICE_AUDIENCE, issuer: "t", secret: SECRET, fetchImpl, sleep: async () => {}, retries });
const down = (async () => json(503, { error: { message: "down" } })) as unknown as typeof fetch;

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); resetSharedSearchServiceClientForTests();
  for (const k of ["SEARCH_TRANSPORT", "SEARCH_REMOTE_FALLBACK", "SEARCH_SERVICE_URL", "SEARCH_SERVICE_TOKEN_SECRET", "SEARCH_SERVICE_TIMEOUT_MS", "SEARCH_SERVICE_RETRIES", "SERVICE_NAME"]) delete process.env[k];
});

describe("env", () => {
  it("defaults to in-process with fallback", () => {
    expect(searchTransport({})).toBe("inproc");
    expect(searchTransport({ SEARCH_TRANSPORT: "http" })).toBe("http");
    expect(searchFallbackEnabled({})).toBe(true);
    expect(searchFallbackEnabled({ SEARCH_REMOTE_FALLBACK: "none" })).toBe(false);
  });
  it("requires URL and secret; shares one client", () => {
    expect(() => searchServiceClientFromEnv({})).toThrow(/SEARCH_SERVICE_URL/);
    expect(searchServiceClientFromEnv({ SEARCH_SERVICE_URL: "http://x", SEARCH_SERVICE_TOKEN_SECRET: SECRET, SEARCH_SERVICE_TIMEOUT_MS: "x", SERVICE_NAME: "web" })).toBeInstanceOf(ServiceClient);
    process.env.SEARCH_SERVICE_URL = "http://x"; process.env.SEARCH_SERVICE_TOKEN_SECRET = SECRET;
    expect(sharedSearchServiceClient()).toBe(sharedSearchServiceClient());
  });
});

describe("remoteSearch / remoteSuggest", () => {
  it("POSTs the options with a token for the search-service audience", async () => {
    const f = vi.fn(async (url: any, init: any) => {
      expect(new URL(String(url)).pathname).toBe("/v1/search");
      expect(verifyServiceToken(String(init.headers.authorization).slice(7), { secret: SECRET, audience: SEARCH_SERVICE_AUDIENCE }).ok).toBe(true);
      expect(JSON.parse(init.body)).toEqual({ q: "boxes", limit: 5 });
      return json(200, { hits: [{ id: 1 }], tookMs: 3 });
    }) as unknown as typeof fetch;
    await expect(remoteSearch(client(f), { q: "boxes", limit: 5 }, null)).resolves.toEqual({ hits: [{ id: 1 }], tookMs: 3 });
  });
  it("retries once on 5xx, then falls back in-process only on unavailability", async () => {
    const f = vi.fn(down);
    const local = vi.fn(async () => ({ hits: [] as unknown[], tookMs: 1 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(remoteSearch(client(f as any, 1), {}, local)).resolves.toEqual({ hits: [], tookMs: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    await expect(remoteSearch(client(down), {}, null)).rejects.toThrow(ServiceUnavailableError);
    const bad = (async () => json(401, { error: { message: "no" } })) as unknown as typeof fetch;
    await expect(remoteSearch(client(bad), {}, local)).rejects.toThrow(ServiceRejectedError);
    expect(local).toHaveBeenCalledTimes(1);
  });
  it("treats a malformed body as unavailability", async () => {
    for (const body of [null, [], { nohits: 1 }, { hits: "x" }]) {
      await expect(remoteSearch(client((async () => json(200, body)) as unknown as typeof fetch), {}, null)).rejects.toThrow(/malformed body/);
    }
    await expect(remoteSuggest(client((async () => json(200, { suggestions: "x" })) as unknown as typeof fetch), "a", 3, null)).rejects.toThrow(/malformed body/);
  });
  it("suggest encodes the prefix and falls back", async () => {
    const f = vi.fn(async (url: any, init: any) => { expect(String(url)).toBe("http://search/v1/suggest?prefix=a%26b%20c&limit=4"); expect(init.method).toBe("GET"); return json(200, { suggestions: ["x"] }); }) as unknown as typeof fetch;
    await expect(remoteSuggest(client(f), "a&b c", 4, null)).resolves.toEqual(["x"]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(remoteSuggest(client(down), "a", 4, async () => ["local"])).resolves.toEqual(["local"]);
  });
});

describe("entry-point switch (SEARCH_TRANSPORT=http)", () => {
  const enable = () => { process.env.SEARCH_TRANSPORT = "http"; process.env.SEARCH_SERVICE_URL = "http://search.internal"; process.env.SEARCH_SERVICE_TOKEN_SECRET = SECRET; process.env.SEARCH_SERVICE_RETRIES = "1"; };

  it("searchListings and suggest go over HTTP", async () => {
    enable();
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => { const u = new URL(String(url)); seen.push(u.pathname); return u.pathname === "/v1/search" ? json(200, { hits: [], tookMs: 9 }) : json(200, { suggestions: ["remote"] }); }));
    await expect(searchListings({ q: "boxes" })).resolves.toEqual({ hits: [], tookMs: 9 });
    await expect(suggest("bo")).resolves.toEqual(["remote"]);
    expect(seen).toEqual(["/v1/search", "/v1/suggest"]);
  });
  it("answers in-process when the service is down (default) and propagates with SEARCH_REMOTE_FALLBACK=none", async () => {
    enable();
    vi.stubGlobal("fetch", vi.fn(async () => json(503, {})));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await searchListings({ q: "zzzz-no-such-product-xyz" });
    expect(r.hits).toEqual([]);
    expect((await suggest("")).length).toBeGreaterThan(0);
    expect(await suggest("")).toEqual(EXAMPLE_QUERIES.slice(0, 8));
    process.env.SEARCH_REMOTE_FALLBACK = "none";
    await expect(searchListings({ q: "boxes" })).rejects.toThrow(ServiceUnavailableError);
    await expect(suggest("bo")).rejects.toThrow(ServiceUnavailableError);
  });
});
