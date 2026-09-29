import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createOpenSearchClient, OpenSearchIndex } from "../src/index-port/opensearch";
import { decodeCursor, encodeCursor, buildKnnRequest, buildLexicalRequest, buildSuggestRequest } from "../src/index-port/query";
import { getSearchIndex, setSearchIndexForTests } from "../src/index-port/factory";
import { postgresIndex } from "../src/index-port/postgres";

vi.mock("@cnote/catalogue", () => ({ retrieveListings: async () => [] }));

const doc = (id: string) => ({ listingId: id, sellerBusinessId: "s", categoryId: "c", categorySlug: "p", categoryName: "P", title: "t", description: "d", city: null, state: null, verificationTier: 1, trustScore: 1, badgeActive: false, pricePaise: null, moq: null, updatedAt: "2026-01-01T00:00:00Z" }) as any;
const ok = (body: any = {}) => async () => ({ body });
function client(over: any = {}) {
  return {
    search: vi.fn(ok({ hits: { hits: [] } })), bulk: vi.fn(ok({ items: [] })), cat: { plugins: vi.fn(ok([])) }, cluster: { health: vi.fn(ok({ status: "green" })) },
    indices: { create: vi.fn(ok()), exists: vi.fn(ok()), getAlias: vi.fn(ok({})), updateAliases: vi.fn(ok()), delete: vi.fn(ok()), refresh: vi.fn(ok()) }, ...over,
  } as any;
}

describe("cursor", () => {
  it("round-trips any offset in range; out-of-range/non-integer/negative reset to 0", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000 }), (n) => { expect(decodeCursor(encodeCursor(n))).toBe(n); }));
    for (const n of [-1, 10_001, 1.5]) expect(decodeCursor(encodeCursor(n))).toBe(0);
    expect(decodeCursor(Buffer.from('{"o":"5"}').toString("base64url"))).toBe(0);
    fc.assert(fc.property(fc.string(), (s) => { expect(decodeCursor(s)).toBeGreaterThanOrEqual(0); }));
  });
  it("pagination is stable: page N+1 starts exactly where page N ended", () => {
    const l0 = buildLexicalRequest({ text: "x", location: null, limit: 30 });
    const l1 = buildLexicalRequest({ text: "x", location: null, limit: 30, cursor: encodeCursor(30) });
    expect(l0.from + l0.size).toBe(l1.from);
  });
  it("facets are only computed on the first page; knn k covers offset+limit", () => {
    const q = { text: "x", location: null, limit: 30, cursor: encodeCursor(60), embedding: [1] };
    expect(buildLexicalRequest(q, { facets: false })).not.toHaveProperty("aggs");
    expect((buildKnnRequest(q) as any).query.knn.embedding.k).toBe(90);
    expect(buildSuggestRequest("da", 5).query.match["title.edge"].query).toBe("da");
  });
});

describe("OpenSearchIndex extra", () => {
  it("first page requests facets, later pages do not; empty text skips lexical", async () => {
    const c = client();
    const idx = new OpenSearchIndex(c);
    await idx.search({ text: "box", location: null, limit: 5 });
    expect(c.search.mock.calls[0][0].body).toHaveProperty("aggs");
    await idx.search({ text: "box", location: null, limit: 5, cursor: encodeCursor(5) });
    expect(c.search.mock.calls[1][0].body).not.toHaveProperty("aggs");
    c.search.mockClear();
    const r = await idx.search({ text: "  ", location: null, limit: 5, embedding: [1] });
    expect(c.search).toHaveBeenCalledTimes(1);
    expect(r.hits).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });
  it("nextCursor only when a list fills the page", async () => {
    const hits = (n: number) => ({ hits: { hits: Array.from({ length: n }, (_, i) => ({ _score: 1, _source: { listingId: `l${i}`, sellerBusinessId: "s" } })) } });
    const idx = new OpenSearchIndex(client({ search: vi.fn(async () => ({ body: hits(3) })) }));
    expect((await idx.search({ text: "x", location: null, limit: 3, cursor: encodeCursor(3) })).nextCursor).toBe(encodeCursor(6));
    expect((await idx.search({ text: "x", location: null, limit: 4 })).nextCursor).toBeNull();
  });
  it("suggest dedups and limits", async () => {
    const c = client({ search: vi.fn(async () => ({ body: { hits: { hits: ["a", "a", "b", "c"].map((t) => ({ _source: { title: t } })) } } })) });
    expect(await new OpenSearchIndex(c).suggest("x", 2)).toEqual(["a", "b"]);
    const c2 = client({ search: vi.fn(async () => ({ body: {} })) });
    expect(await new OpenSearchIndex(c2).suggest("x")).toEqual([]);
  });
  it("ensureIndex: reuses newest existing, creates v1 with alias, tolerates concurrent creator, rethrows others, 404 alias => none", async () => {
    let c = client({ indices: { ...client().indices, getAlias: vi.fn(ok({ listings_v1: {}, listings_v3: {} })) } });
    expect(await new OpenSearchIndex(c).ensureIndex()).toBe("listings_v3");
    c = client();
    expect(await new OpenSearchIndex(c).ensureIndex()).toBe("listings_v1");
    expect(c.indices.create.mock.calls[0][0].body.aliases).toEqual({ listings: {} });
    c = client(); c.indices.create = vi.fn(async () => { throw new Error("resource_already_exists_exception"); });
    expect(await new OpenSearchIndex(c).ensureIndex()).toBe("listings_v1");
    c.indices.create = vi.fn(async () => { throw new Error("nope"); });
    await expect(new OpenSearchIndex(c).ensureIndex()).rejects.toThrow("nope");
    c.indices.create = vi.fn(ok());
    c.indices.getAlias = vi.fn(async () => { throw Object.assign(new Error("nf"), { statusCode: 404 }); });
    expect(await new OpenSearchIndex(c, { synonyms: [] }).ensureIndex()).toBe("listings_v1");
    c.indices.getAlias = vi.fn(async () => { throw Object.assign(new Error("boom"), { statusCode: 500 }); });
    await expect(new OpenSearchIndex(c).ensureIndex()).rejects.toThrow("boom");
  });
  it("detects ICU plugin once, falls back when cat fails", async () => {
    const c = client(); c.cat.plugins = vi.fn(ok([{ component: "analysis-icu" }]));
    const idx = new OpenSearchIndex(c);
    await idx.ensureIndex(); await idx.upsert([doc("a")]);
    expect(c.cat.plugins).toHaveBeenCalledTimes(1);
    expect(c.indices.create.mock.calls[0][0].body.settings.analysis.analyzer.indic.tokenizer).toBe("icu_tokenizer");
    const c2 = client(); c2.cat.plugins = vi.fn(async () => { throw new Error("x"); });
    await new OpenSearchIndex(c2).ensureIndex();
    expect(c2.indices.create.mock.calls[0][0].body.settings.analysis.analyzer.indic.tokenizer).toBe("standard");
  });
  it("upsert/remove with empty input do nothing; remove uses external_gte and errors on failures", async () => {
    const c = client();
    const idx = new OpenSearchIndex(c);
    await idx.upsert([]); await idx.remove([]);
    expect(c.bulk).not.toHaveBeenCalled();
    c.bulk = vi.fn(ok({ items: [{ delete: { status: 500 } }] }));
    await expect(idx.remove(["a"])).rejects.toThrow(/remove/);
    expect(c.bulk.mock.calls[0][0].body[0].delete.version_type).toBe("external_gte");
  });
  it("stale (409) upserts are neither indexed nor failed in reindexAll", async () => {
    const c = client({ bulk: vi.fn(ok({ items: [{ index: { status: 409 } }, { index: { status: 201 } }, { index: { status: 500 } }] })) });
    c.indices.getAlias = vi.fn(ok({ listings_v1: {}, listings_v2: {}, listings_v0: {} }));
    async function* s() { yield []; yield [doc("a"), doc("b"), doc("c")]; }
    const r = await new OpenSearchIndex(c).reindexAll(s());
    expect(r).toEqual({ indexed: 1, failed: 1, index: "listings_v3" });
    expect(c.indices.delete.mock.calls.map((x: any) => x[0].index).sort()).toEqual(["listings_v0", "listings_v1"]); // keeps v2 for rollback
  });
  it("health: red/unreachable => not ok", async () => {
    expect((await new OpenSearchIndex(client({ cluster: { health: ok({ status: "red" }) } })).health()).ok).toBe(false);
    const h = await new OpenSearchIndex(client({ cluster: { health: async () => { throw new Error("econn"); } } })).health();
    expect(h).toMatchObject({ ok: false, detail: "econn" });
  });
});

describe("client + factory", () => {
  it("requires OPENSEARCH_URL; builds with/without auth", () => {
    expect(() => createOpenSearchClient({})).toThrow(/OPENSEARCH_URL/);
    expect(createOpenSearchClient({ OPENSEARCH_URL: "http://localhost:9200" })).toBeDefined();
    expect(createOpenSearchClient({ OPENSEARCH_URL: "https://x:9200", OPENSEARCH_USERNAME: "u", OPENSEARCH_INSECURE_TLS: "true" })).toBeDefined();
  });
  it("getSearchIndex honours SEARCH_BACKEND, caches, and override", () => {
    setSearchIndexForTests(undefined);
    const prev = { b: process.env.SEARCH_BACKEND, u: process.env.OPENSEARCH_URL };
    delete process.env.SEARCH_BACKEND;
    expect(getSearchIndex()).toBe(postgresIndex);
    expect(getSearchIndex()).toBe(postgresIndex);
    process.env.SEARCH_BACKEND = "opensearch"; process.env.OPENSEARCH_URL = "http://localhost:9200";
    const os = getSearchIndex();
    expect(os.backend).toBe("opensearch");
    expect(getSearchIndex()).toBe(os);
    const o = { backend: "postgres" } as any;
    setSearchIndexForTests(o);
    expect(getSearchIndex()).toBe(o);
    setSearchIndexForTests(undefined);
    if (prev.b === undefined) delete process.env.SEARCH_BACKEND; else process.env.SEARCH_BACKEND = prev.b;
    if (prev.u === undefined) delete process.env.OPENSEARCH_URL; else process.env.OPENSEARCH_URL = prev.u;
  });
});
