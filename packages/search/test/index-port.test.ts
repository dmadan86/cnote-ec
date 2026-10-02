import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
vi.mock("@cnote/catalogue", () => ({ retrieveListings: (o: unknown) => retrieve(o) }));

const { postgresIndex } = await import("../src/index-port/postgres");
const { OpenSearchIndex, parseFacets } = await import("../src/index-port/opensearch");
const { buildIndexBody, loadSynonyms, indexName, parseIndexVersion, toSourceDoc, knnScoreToCosine, EMBEDDING_DIM } = await import("../src/index-port/mapping");
const { buildLexicalRequest, buildKnnRequest, encodeCursor, decodeCursor } = await import("../src/index-port/query");
const { rrfFuse, toCandidates } = await import("../src/fusion");
const { searchBackendName } = await import("../src/index-port/factory");

const doc = (id: string, over = {}) => ({
  listingId: id, sellerBusinessId: "s1", categoryId: "c1", categorySlug: "packaging", categoryName: "Packaging", title: "Corrugated box",
  description: "d", city: "Surat", state: "Gujarat", verificationTier: 2, trustScore: 80, badgeActive: true, pricePaise: 5000, moq: 100,
  updatedAt: "2026-01-01T00:00:00Z", ...over,
});

function fakeClient(searchImpl: (p: any) => any = () => ({ hits: { hits: [] } })) {
  const calls: { fn: string; arg: any }[] = [];
  const rec = (fn: string, ret: any) => async (arg?: any) => { calls.push({ fn, arg }); return { body: typeof ret === "function" ? ret(arg) : ret }; };
  const aliasState = { names: ["listings_v1"] as string[] };
  const client: any = {
    search: rec("search", searchImpl),
    bulk: rec("bulk", (a: any) => ({ items: a.body.filter((x: any) => x.index || x.delete).map((x: any) => (x.index ? { index: { status: 201 } } : { delete: { status: 200 } })) })),
    cat: { plugins: rec("plugins", [{ component: "analysis-icu" }]) },
    cluster: { health: rec("health", { status: "green" }) },
    indices: {
      create: rec("create", {}),
      exists: rec("exists", true),
      getAlias: rec("getAlias", () => Object.fromEntries(aliasState.names.map((n) => [n, {}]))),
      updateAliases: rec("updateAliases", {}),
      delete: rec("delete", {}),
      refresh: rec("refresh", {}),
    },
  };
  return { client, calls };
}

describe("mapping", () => {
  it("uses ICU when available, else standard + asciifolding", () => {
    const a = buildIndexBody({ icu: true }).settings.analysis.analyzer.indic;
    expect(a.tokenizer).toBe("icu_tokenizer");
    expect(a.filter).toContain("icu_folding");
    const b = buildIndexBody({ icu: false }).settings.analysis.analyzer.indic;
    expect(b.tokenizer).toBe("standard");
    expect(b.filter).toEqual(["lowercase", "asciifolding"]);
  });
  it("defines shingles, edge-ngram, knn vector, filter keywords, strict mapping", () => {
    const m = buildIndexBody({ icu: false, synonyms: ["a => b"] });
    const p: any = m.mappings.properties;
    expect(m.mappings.dynamic).toBe("strict");
    expect(p.title.fields.shingles).toBeDefined();
    expect(p.title.fields.edge.analyzer).toBe("title_edge");
    expect(p.embedding).toMatchObject({ type: "knn_vector", dimension: EMBEDDING_DIM, method: { name: "hnsw", space_type: "cosinesimil" } });
    for (const f of ["categoryId", "sellerBusinessId", "city", "state", "verificationTier"]) expect(p[f].type).toBe("keyword");
    expect(p.trustScore.type).toBe("float");
    expect(p.pricePaise.type).toBe("long");
    expect(m.settings.analysis.filter.b2b_synonyms.synonyms).toEqual(["a => b"]);
  });
  it("uses a hot-updatable package path when configured", () => {
    const f = buildIndexBody({ icu: false, synonymsPackagePath: "analyzers/F1" }).settings.analysis.filter.b2b_synonyms as any;
    expect(f).toMatchObject({ synonyms_path: "analyzers/F1", updateable: true });
  });
  it("loads the Hinglish synonym file", () => {
    const s = loadSynonyms();
    expect(s.some((l) => l.includes("dabba") && l.endsWith("=> box"))).toBe(true);
    expect(s.some((l) => l.startsWith("#"))).toBe(false);
  });
  it("versioned index names and score conversion", () => {
    expect(indexName(3)).toBe("listings_v3");
    expect(parseIndexVersion("listings_v12")).toBe(12);
    expect(parseIndexVersion("other")).toBe(0);
    expect(knnScoreToCosine(1)).toBe(1);
    expect(knnScoreToCosine(0.5)).toBe(0);
  });
  it("source doc stringifies tier and drops wrong-dimension embeddings", () => {
    expect(toSourceDoc(doc("a") as any).verificationTier).toBe("2");
    expect("embedding" in toSourceDoc(doc("a", { embedding: [1, 2] }) as any)).toBe(false);
  });
});

describe("query builder", () => {
  const q = { text: "dabba", location: null, limit: 30, categoryId: "c1" };
  it("lexical: fuzzy multi_match, category filter, facets aggs", () => {
    const r: any = buildLexicalRequest(q, { facets: true });
    expect(r.query.bool.must[0].multi_match.fuzziness).toBe("AUTO");
    expect(r.query.bool.filter).toEqual([{ term: { categoryId: "c1" } }]);
    expect(Object.keys(r.aggs)).toEqual(["category", "city", "state", "verificationTier", "price"]);
    expect(buildLexicalRequest({ ...q, categoryId: null })).not.toHaveProperty("aggs");
  });
  it("knn only with an embedding, filtered by category", () => {
    expect(buildKnnRequest(q)).toBeNull();
    const r: any = buildKnnRequest({ ...q, embedding: [0.1] });
    expect(r.query.knn.embedding.filter).toEqual({ term: { categoryId: "c1" } });
  });
  it("cursor round-trips and rejects garbage", () => {
    expect(decodeCursor(encodeCursor(60))).toBe(60);
    expect(decodeCursor("!!!")).toBe(0);
    expect(decodeCursor(null)).toBe(0);
  });
});

describe("OpenSearchIndex", () => {
  it("search merges lexical and vector lists, exposes facets and a cursor", async () => {
    const { client, calls } = fakeClient((p) =>
      p.body.query.knn
        ? { hits: { hits: [{ _score: 0.9, _source: { listingId: "b", sellerBusinessId: "s" } }, { _score: 0.7, _source: { listingId: "c", sellerBusinessId: "s" } }] } }
        : { hits: { hits: [{ _score: 5, _source: { listingId: "a", sellerBusinessId: "s" } }, { _score: 3, _source: { listingId: "b", sellerBusinessId: "s" } }] }, aggregations: { category: { buckets: [{ key: "packaging", doc_count: 2 }] }, city: { buckets: [] }, verificationTier: { buckets: [] }, price: { buckets: [{ key: "under-1k", doc_count: 1 }] } } },
    );
    const idx = new OpenSearchIndex(client);
    const r = await idx.search({ text: "box", location: null, limit: 2, embedding: [0.1] });
    expect(calls.filter((c) => c.fn === "search")).toHaveLength(2);
    const byId = Object.fromEntries(r.hits.map((h) => [h.listingId, h]));
    expect(byId.a).toMatchObject({ lexicalScore: 5, vectorScore: 0 });
    expect(byId.b!.lexicalScore).toBe(3);
    expect(byId.b!.vectorScore).toBeCloseTo(0.8);
    expect(byId.c).toMatchObject({ lexicalScore: 0 });
    expect(r.nextCursor).toBe(encodeCursor(2));
    expect(r.facets?.category).toEqual([{ key: "packaging", count: 2 }]);
    expect(r.facets?.price[0]).toMatchObject({ key: "under-1k", fromPaise: null, toPaise: 100_000 });
  });

  it("upsert uses external_gte versioning (idempotent) and creates the index once", async () => {
    const { client, calls } = fakeClient();
    const idx = new OpenSearchIndex(client);
    await idx.upsert([doc("a", { version: 42 })]);
    await idx.upsert([doc("a", { version: 42 })]);
    const bulks = calls.filter((c) => c.fn === "bulk");
    expect(bulks[0]!.arg.body[0].index).toMatchObject({ _id: "a", version: 42, version_type: "external_gte", _index: "listings" });
    expect(bulks[0]!.arg.body).toEqual(bulks[1]!.arg.body);
  });

  it("treats version conflicts as success and real failures as errors", async () => {
    const { client } = fakeClient();
    client.bulk = async () => ({ body: { items: [{ index: { status: 409 } }] } });
    await expect(new OpenSearchIndex(client).upsert([doc("a")])).resolves.toBeUndefined();
    client.bulk = async () => ({ body: { items: [{ index: { status: 500 } }] } });
    await expect(new OpenSearchIndex(client).upsert([doc("a")])).rejects.toThrow(/failed/);
  });

  it("remove ignores 404/409", async () => {
    const { client } = fakeClient();
    client.bulk = async () => ({ body: { items: [{ delete: { status: 404 } }, { delete: { status: 409 } }] } });
    await expect(new OpenSearchIndex(client).remove(["a", "b"])).resolves.toBeUndefined();
  });

  it("reindexAll builds v2, swaps the alias atomically and prunes old indices", async () => {
    const { client, calls } = fakeClient();
    async function* stream() { yield [doc("a")]; yield [doc("b")]; }
    const r = await new OpenSearchIndex(client).reindexAll(stream());
    expect(r).toEqual({ indexed: 2, failed: 0, index: "listings_v2" });
    expect(calls.find((c) => c.fn === "create")!.arg.index).toBe("listings_v2");
    expect(calls.find((c) => c.fn === "updateAliases")!.arg.body.actions).toEqual([{ remove: { index: "listings_v1", alias: "listings" } }, { add: { index: "listings_v2", alias: "listings" } }]);
    // only one old index: kept for rollback
    expect(calls.some((c) => c.fn === "delete")).toBe(false);
  });

  it("reindexAll drops the half-built index and leaves the alias untouched on failure", async () => {
    const { client, calls } = fakeClient();
    async function* stream(): AsyncGenerator<any[]> { yield [doc("a")]; throw new Error("boom"); }
    await expect(new OpenSearchIndex(client).reindexAll(stream())).rejects.toThrow("boom");
    expect(calls.some((c) => c.fn === "updateAliases")).toBe(false);
    expect(calls.find((c) => c.fn === "delete")!.arg.index).toBe("listings_v2");
  });

  it("health reports cluster status", async () => {
    const { client } = fakeClient();
    expect(await new OpenSearchIndex(client).health()).toMatchObject({ ok: true, backend: "opensearch" });
  });
  it("parseFacets tolerates missing aggregations", () => expect(parseFacets({}).category).toEqual([]));
});

describe("backend parity", () => {
  it("same raw scores => same fused order regardless of backend", async () => {
    // Postgres reports ts_rank_cd / cosine; OpenSearch reports BM25 / (1+cos)/2. Different scales, same order => same RRF.
    retrieve.mockResolvedValue([
      { listingId: "a", sellerBusinessId: "s", lexicalRank: 0.4, similarity: 0.5 },
      { listingId: "b", sellerBusinessId: "s", lexicalRank: 0.2, similarity: 0.9 },
      { listingId: "c", sellerBusinessId: "s", lexicalRank: 0, similarity: 0.6 },
    ]);
    const pg = await postgresIndex.search({ text: "x", location: null, limit: 10 });
    const { client } = fakeClient((p) =>
      p.body.query.knn
        ? { hits: { hits: [{ _score: 0.95, _source: { listingId: "b", sellerBusinessId: "s" } }, { _score: 0.8, _source: { listingId: "c", sellerBusinessId: "s" } }, { _score: 0.75, _source: { listingId: "a", sellerBusinessId: "s" } }] } }
        : { hits: { hits: [{ _score: 12, _source: { listingId: "a", sellerBusinessId: "s" } }, { _score: 7, _source: { listingId: "b", sellerBusinessId: "s" } }] } },
    );
    const os = await new OpenSearchIndex(client).search({ text: "x", location: null, limit: 10, embedding: [1] });
    const order = (hits: typeof pg.hits) => [...rrfFuse(toCandidates(hits)).entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order(os.hits)).toEqual(order(pg.hits));
  });
});

describe("postgres adapter + factory", () => {
  beforeEach(() => retrieve.mockReset());
  it("maps retrieveListings output and passes options through; writes are no-ops", async () => {
    retrieve.mockResolvedValue([{ listingId: "a", sellerBusinessId: "s", lexicalRank: 0.3, similarity: 0.6 }]);
    const r = await postgresIndex.search({ text: "box", location: "surat", embedding: [1], categoryId: "c", limit: 5 });
    expect(retrieve).toHaveBeenCalledWith({ text: "box", embedding: [1], categoryId: "c", limit: 5 });
    expect(r).toEqual({ hits: [{ listingId: "a", sellerBusinessId: "s", lexicalScore: 0.3, vectorScore: 0.6 }], nextCursor: null });
    await postgresIndex.upsert([]);
    await postgresIndex.remove(["a"]);
    expect(await postgresIndex.reindexAll((async function* () { yield []; })())).toEqual({ indexed: 0, failed: 0, index: null });
    expect((await postgresIndex.health()).ok).toBe(true);
  });
  it("SEARCH_BACKEND defaults to postgres and rejects unknown values", () => {
    expect(searchBackendName({})).toBe("postgres");
    expect(searchBackendName({ SEARCH_BACKEND: "OpenSearch" })).toBe("opensearch");
    expect(() => searchBackendName({ SEARCH_BACKEND: "solr" })).toThrow();
  });
});

// Contract tests against a real cluster: only when OPENSEARCH_URL is set.
describe.skipIf(!process.env.OPENSEARCH_URL)("OpenSearch contract (live cluster)", () => {
  it("indexes, searches and removes", async () => {
    const { createOpenSearchClient } = await import("../src/index-port/opensearch");
    const idx = new OpenSearchIndex(createOpenSearchClient() as any);
    const id = `00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0").slice(-12)}`;
    await idx.upsert([doc(id, { title: "Contract test dabba" })]);
    await (createOpenSearchClient() as any).indices.refresh({ index: "listings" });
    const r = await idx.search({ text: "box", location: null, limit: 10 });
    expect(r.hits.some((h) => h.listingId === id)).toBe(true);
    await idx.remove([id]);
    expect((await idx.health()).ok).toBe(true);
  });
});
