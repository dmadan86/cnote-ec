// CI-safe relevance floor (ADR-009). The fixture corpus is created inside the test (live read DB, random category ids,
// removed afterwards), so this never reads seed rows. Real heuristic embeddings, real Postgres FTS + pgvector.
import { describe, expect, it } from "vitest";
import { floorViolations } from "../src/relevance/run";
import { productKeyOf } from "../src/relevance/format";
import { evaluateFixture, loadBaselineFile, loadFixtureFile } from "../relevance/harness";

process.env.AI_PROVIDER = "heuristic";

const file = loadFixtureFile();

describe("fixture integrity", () => {
  it("keys are the title slugs, so admin exports and fixtures speak the same descriptors", () => {
    for (const c of file.corpus!) expect(c.key, c.title).toBe(productKeyOf(c.title));
  });
  it("covers English, Hinglish and every supported Indic script plus mixed script", () => {
    const langs = new Set(file.queries.map((q) => q.lang));
    for (const l of ["en", "hinglish", "hi", "mr", "gu", "kn", "ta", "te", "bn", "mixed"]) expect(langs.has(l), l).toBe(true);
  });
  it("every query has at least one relevant item", () => {
    for (const q of file.queries) expect(Object.values(q.relevant).some((g) => g > 0), q.id).toBe(true);
  });
});

describe("relevance on the postgres backend", () => {
  it("meets the committed baseline floor (nDCG@10, MRR, recall@20)", async () => {
    const scores = await evaluateFixture(file, "postgres");
    expect(scores.queries).toBe(file.queries.length);
    expect(floorViolations("postgres", scores, loadBaselineFile())).toEqual([]);
    // absolute sanity, independent of the baseline file, so a careless --write-baseline cannot hide a collapse
    expect(scores.ndcg10).toBeGreaterThan(0.8);
    expect(scores.recall20).toBeGreaterThan(0.7);
  });

  it("a curated synonym group lifts a query the built-in lexicon under-serves ('kapda' also means garments)", async () => {
    const before = await evaluateFixture({ ...file, queries: file.queries.filter((q) => q.id === "hg-01") }, "postgres");
    const after = await evaluateFixture({ ...file, queries: file.queries.filter((q) => q.id === "hg-01") }, "postgres", { synonyms: [{ terms: ["kapda", "t-shirts", "saree"] }] });
    expect(after.ndcg10).toBeGreaterThan(before.ndcg10);
  });

  it("the floor check reports every regressed metric and a missing backend", () => {
    const base = { tolerance: 0.02, backends: { postgres: { ndcg10: 0.9, mrr: 0.9, recall20: 0.9 } } };
    expect(floorViolations("postgres", { ndcg10: 0.9, mrr: 0.89, recall20: 0.9 }, base)).toEqual([]);
    expect(floorViolations("postgres", { ndcg10: 0.5, mrr: 0.5, recall20: 0.5 }, base)).toHaveLength(3);
    expect(floorViolations("opensearch", { ndcg10: 1, mrr: 1, recall20: 1 }, base)[0]).toMatch(/no committed baseline/);
  });
});
