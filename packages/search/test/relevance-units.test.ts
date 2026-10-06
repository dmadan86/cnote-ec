import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/catalogue", () => ({ retrieveListings: vi.fn() }));
import { evaluateRun, recallAtK } from "../src/eval/metrics";
import { indexName, parseIndexVersion } from "../src/index-port/mapping";
import { scoreFile } from "../src/relevance/run";

const { OpenSearchIndex } = await import("../src/index-port/opensearch");

describe("recallAtK / evaluateRun", () => {
  it("is the share of relevant (grade > 0) items inside the first k distinct results", () => {
    expect(recallAtK(["a", "x", "b"], { a: 3, b: 1, c: 2, z: 0 }, 20)).toBeCloseTo(2 / 3, 10);
    expect(recallAtK(["a", "x", "b"], { a: 3, b: 1, c: 2 }, 2)).toBeCloseTo(1 / 3, 10);
    expect(recallAtK(["a", "a", "a", "b"], { a: 1, b: 1 }, 2)).toBe(1); // duplicates do not use up the window
    expect(recallAtK(["a"], { a: 0 })).toBe(0);
    expect(recallAtK([], { a: 1 })).toBe(0);
  });
  it("evaluateRun reports recall@20 alongside nDCG and MRR", () => {
    const e = evaluateRun([{ id: "q", query: "q", lang: "en", relevant: { a: 3, b: 2 } }], { q: ["a"] });
    expect(e.recall20).toBe(0.5);
    expect(e.perQuery[0]!.recall20).toBe(0.5);
  });
});

describe("scoreFile", () => {
  it("scores each query through the injected ranker and groups by language", async () => {
    const file: { queries: { id: string; query: string; lang: string; relevant: Record<string, number> }[] } = {
      queries: [
        { id: "1", query: "alpha", lang: "en", relevant: { a: 3 } },
        { id: "2", query: "beta", lang: "hi", relevant: { b: 3 } },
        { id: "3", query: "gamma", lang: "hi", relevant: { c: 2 } },
      ],
    };
    const ranks: Record<string, string[]> = { alpha: ["a"], beta: ["x", "b"], gamma: [] };
    const s = await scoreFile(file, async (q) => ranks[q]!);
    expect(s.queries).toBe(3);
    expect(s.mrr).toBe(0.5);
    expect(s.byLang.en).toEqual({ queries: 1, ndcg10: 1, mrr: 1, recall20: 1 });
    expect(s.byLang.hi!.queries).toBe(2);
    expect(s.byLang.hi!.recall20).toBe(0.5);
    expect(s.perQuery.find((p) => p.id === "2")!.top).toEqual(["x", "b"]);
  });
});

describe("index alias plumbing", () => {
  it("names and parses versions per alias, and escapes the alias in the pattern", () => {
    expect(indexName(2)).toBe("listings_v2");
    expect(indexName(3, "relevance_ab12")).toBe("relevance_ab12_v3");
    expect(parseIndexVersion("relevance_ab12_v3", "relevance_ab12")).toBe(3);
    expect(parseIndexVersion("listings_v3", "relevance_ab12")).toBe(0);
    expect(parseIndexVersion("listings_v3")).toBe(3);
    expect(parseIndexVersion("listingsXv3", "listings")).toBe(0);
    expect(parseIndexVersion("a.b_v1", "a.b")).toBe(1);
  });

  function fakeClient() {
    const calls: { fn: string; arg: any }[] = [];
    const rec = (fn: string, ret: any) => async (arg?: any) => (calls.push({ fn, arg }), { body: typeof ret === "function" ? ret(arg) : ret });
    const client: any = {
      search: rec("search", { hits: { hits: [] } }),
      bulk: rec("bulk", (a: any) => ({ items: a.body.filter((x: any) => x.index).map(() => ({ index: { status: 201 } })) })),
      cat: { plugins: rec("plugins", []) },
      cluster: { health: rec("health", { status: "green" }) },
      indices: {
        create: rec("create", {}), exists: rec("exists", true), updateAliases: rec("updateAliases", {}), delete: rec("delete", {}), refresh: rec("refresh", {}),
        getAlias: async () => {
          throw Object.assign(new Error("missing"), { statusCode: 404 });
        },
      },
    };
    return { client, calls };
  }
  const doc = { listingId: "l1", sellerBusinessId: "s1", categoryId: "c1", categorySlug: "c", categoryName: "C", title: "t", description: "d", city: null, state: null, verificationTier: 1, trustScore: 1, badgeActive: false, pricePaise: null, moq: null, updatedAt: "2026-01-01T00:00:00Z" };

  it("a private alias isolates reads, writes and index creation from `listings`", async () => {
    const { client, calls } = fakeClient();
    const idx = new OpenSearchIndex(client, { alias: "relevance_x" });
    await idx.upsert([doc]);
    await idx.search({ text: "t", location: null, limit: 5 });
    await idx.remove(["l1"]);
    const create = calls.find((c) => c.fn === "create")!;
    expect(create.arg.index).toBe("relevance_x_v1");
    expect(create.arg.body.aliases).toEqual({ relevance_x: {} });
    expect(calls.find((c) => c.fn === "search")!.arg.index).toBe("relevance_x");
    expect(JSON.stringify(calls.find((c) => c.fn === "bulk")!.arg)).not.toContain('"listings"');
    expect(JSON.stringify(calls.filter((c) => c.fn === "bulk").at(-1)!.arg)).toContain("relevance_x");
  });

  it("curated synonyms are added to the index analyzer next to the shipped file, and a failing provider is ignored", async () => {
    const a = fakeClient();
    await new OpenSearchIndex(a.client, { extraSynonyms: async () => ["kapda, कपड़ा, cloth"] }).upsert([doc]);
    const rules: string[] = a.calls.find((c) => c.fn === "create")!.arg.body.settings.analysis.filter.b2b_synonyms.synonyms;
    expect(rules).toContain("kapda, कपड़ा, cloth");
    expect(rules.some((r) => r.includes("=>"))).toBe(true); // the shipped file is still there

    const b = fakeClient();
    await new OpenSearchIndex(b.client, { extraSynonyms: async () => { throw new Error("db down"); } }).upsert([doc]);
    expect(b.calls.find((c) => c.fn === "create")!.arg.body.settings.analysis.filter.b2b_synonyms.synonyms.length).toBeGreaterThan(5);

    const c = fakeClient();
    await new OpenSearchIndex(c.client, { synonyms: ["only => this"], extraSynonyms: async () => ["ignored, rules"] }).upsert([doc]);
    expect(c.calls.find((x) => x.fn === "create")!.arg.body.settings.analysis.filter.b2b_synonyms.synonyms).toEqual(["only => this"]);
  });
});
