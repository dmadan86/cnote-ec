import { describe, expect, it } from "vitest";
import { MAX_TIER, computeFacets, filtersSchema, matchesFilters, normaliseFilters, priceBucketKey, sortOrganic, type FilterRow, type OrganicItem } from "../src/filters";
import { buildAggs, buildKnnRequest, buildLexicalRequest, filterClauses } from "../src/index-port/query";
import { parseFacets } from "../src/index-port/opensearch";

const row = (o: Partial<FilterRow> = {}): FilterRow => ({ categoryId: "c1", categorySlug: "packaging", tier: 1, state: "Gujarat", city: "Surat", pricePaise: 50_000, moq: 100, ...o });

describe("normaliseFilters", () => {
  it("drops neutral values and canonicalises lists", () => {
    expect(normaliseFilters(undefined)).toEqual({});
    expect(normaliseFilters({ minTier: 0, states: [], hasPrice: false, priceMinPaise: 0, categories: [" b ", "a", "a"] })).toEqual({ categories: ["a", "b"] });
    expect(normaliseFilters({ states: ["Gujarat", " gujarat ", "Delhi"], cities: ["SURAT"] })).toEqual({ states: ["delhi", "gujarat"], cities: ["surat"] });
  });
  it("clamps tier and drops a contradictory price range's upper bound", () => {
    expect(normaliseFilters({ minTier: 3 }).minTier).toBe(MAX_TIER);
    expect(normaliseFilters({ priceMinPaise: 500, priceMaxPaise: 100 })).toEqual({ priceMinPaise: 500 });
    expect(normaliseFilters({ priceMinPaise: 100, priceMaxPaise: 500 })).toEqual({ priceMinPaise: 100, priceMaxPaise: 500 });
  });
  it("schema rejects out-of-range input", () => {
    expect(filtersSchema.safeParse({ minTier: 4 }).success).toBe(false);
    expect(filtersSchema.safeParse({ priceMinPaise: -1 }).success).toBe(false);
    expect(filtersSchema.safeParse({ maxMoq: 0 }).success).toBe(false);
    expect(filtersSchema.safeParse({ states: Array(11).fill("x") }).success).toBe(false);
  });
});

describe("matchesFilters", () => {
  it("minimum tier is inclusive", () => {
    expect(matchesFilters(row({ tier: 2 }), { minTier: 2 })).toBe(true);
    expect(matchesFilters(row({ tier: 1 }), { minTier: 2 })).toBe(false);
  });
  it("state and city match case-insensitively", () => {
    expect(matchesFilters(row(), { states: ["gujarat"] })).toBe(true);
    expect(matchesFilters(row(), { states: ["delhi"] })).toBe(false);
    expect(matchesFilters(row({ city: null }), { cities: ["surat"] })).toBe(false);
  });
  it("price range is inclusive and excludes price-on-request; hasPrice alone only excludes null prices", () => {
    expect(matchesFilters(row({ pricePaise: 100 }), { priceMinPaise: 100, priceMaxPaise: 100 })).toBe(true);
    expect(matchesFilters(row({ pricePaise: null }), { priceMaxPaise: 1_000 })).toBe(false);
    expect(matchesFilters(row({ pricePaise: null }), { hasPrice: true })).toBe(false);
    expect(matchesFilters(row({ pricePaise: 1 }), { hasPrice: true })).toBe(true);
  });
  it("max MOQ keeps listings with no stated MOQ", () => {
    expect(matchesFilters(row({ moq: 500 }), { maxMoq: 100 })).toBe(false);
    expect(matchesFilters(row({ moq: 100 }), { maxMoq: 100 })).toBe(true);
    expect(matchesFilters(row({ moq: null }), { maxMoq: 1 })).toBe(true);
  });
  it("category ids match any of the selected (parent + subcategory) ids", () => {
    expect(matchesFilters(row({ categoryId: "child" }), { categoryIds: ["parent", "child"] })).toBe(true);
    expect(matchesFilters(row({ categoryId: "other" }), { categoryIds: ["parent", "child"] })).toBe(false);
  });
});

describe("computeFacets", () => {
  const rows: FilterRow[] = [
    row({ tier: 3, state: "Gujarat", pricePaise: 50_000, categoryId: "c1", categorySlug: "packaging" }),
    row({ tier: 3, state: "Gujarat", pricePaise: 500_000, categoryId: "c1", categorySlug: "packaging" }),
    row({ tier: 2, state: "Delhi", pricePaise: 5_000_000, categoryId: "c2", categorySlug: "textiles" }),
    row({ tier: 0, state: "Delhi", pricePaise: null, categoryId: "c2", categorySlug: "textiles" }),
    row({ tier: 1, state: null, city: null, pricePaise: 20_000_000, categoryId: "c2", categorySlug: "textiles" }),
  ];
  const get = (b: { key: string; count: number }[]) => Object.fromEntries(b.map((x) => [x.key, x.count]));

  it("without filters counts every dimension over all rows", () => {
    const f = computeFacets(rows, {});
    expect(get(f.verificationTier)).toEqual({ "3": 2, "2": 1, "1": 1, "0": 1 });
    expect(get(f.state)).toEqual({ gujarat: 2, delhi: 2 });
    expect(get(f.category)).toEqual({ packaging: 2, textiles: 3 });
    expect(get(f.price)).toEqual({ "under-1k": 1, "1k-10k": 1, "10k-1l": 1, "above-1l": 1 });
    expect(f.price.map((b) => b.key)).toEqual(["under-1k", "1k-10k", "10k-1l", "above-1l"]);
    expect(f.verificationTier.map((b) => b.key)).toEqual(["3", "2", "1", "0"]);
  });
  it("is disjunctive: a dimension ignores its own filter but honours all the others", () => {
    const f = computeFacets(rows, { minTier: 3, states: ["delhi"] });
    // tier facet: state=delhi applied, tier ignored
    expect(get(f.verificationTier)).toEqual({ "2": 1, "0": 1 });
    // state facet: tier>=3 applied, state ignored
    expect(get(f.state)).toEqual({ gujarat: 2 });
    // category facet: both applied
    expect(get(f.category)).toEqual({});
  });
  it("price facet ignores the price range but not hasPrice/MOQ", () => {
    const f = computeFacets(rows, { priceMinPaise: 1_000_000, maxMoq: 50 });
    expect(get(f.price)["under-1k"]).toBe(0); // moq 100 > 50 removes every row with a moq; none left except null-moq rows (none here)
    const g = computeFacets(rows, { priceMinPaise: 1_000_000 });
    expect(get(g.price)).toEqual({ "under-1k": 1, "1k-10k": 1, "10k-1l": 1, "above-1l": 1 });
  });
  it("price buckets are [from, to)", () => {
    expect(priceBucketKey(99_999)).toBe("under-1k");
    expect(priceBucketKey(100_000)).toBe("1k-10k");
    expect(priceBucketKey(10_000_000)).toBe("above-1l");
  });
});

const it_ = (id: string, o: Partial<OrganicItem> = {}): OrganicItem => ({ id, score: 1, pricePaise: 100, publishedAtMs: 1, tier: 0, trustScore: 0, ...o });
const ids = (xs: OrganicItem[]) => xs.map((x) => x.id);

describe("sortOrganic", () => {
  it("relevance: score desc, ties by id", () => {
    expect(ids(sortOrganic([it_("b", { score: 1 }), it_("a", { score: 1 }), it_("c", { score: 2 })]))).toEqual(["c", "a", "b"]);
  });
  it("price: ascending/descending, price-on-request last in both", () => {
    const xs = [it_("n", { pricePaise: null, score: 9 }), it_("hi", { pricePaise: 900 }), it_("lo", { pricePaise: 100 }), it_("mid", { pricePaise: 500 })];
    expect(ids(sortOrganic(xs, "price_asc"))).toEqual(["lo", "mid", "hi", "n"]);
    expect(ids(sortOrganic(xs, "price_desc"))).toEqual(["hi", "mid", "lo", "n"]);
  });
  it("newest: most recently first-published first", () => {
    expect(ids(sortOrganic([it_("old", { publishedAtMs: 1 }), it_("new", { publishedAtMs: 9 }), it_("mid", { publishedAtMs: 5 })], "newest"))).toEqual(["new", "mid", "old"]);
  });
  it("trust: verification tier first, then trust score, then relevance", () => {
    const xs = [it_("t1-hi", { tier: 1, trustScore: 99 }), it_("t3-lo", { tier: 3, trustScore: 10 }), it_("t3-hi", { tier: 3, trustScore: 80 }), it_("t3-hi-rel", { tier: 3, trustScore: 80, score: 5 })];
    expect(ids(sortOrganic(xs, "trust"))).toEqual(["t3-hi-rel", "t3-hi", "t3-lo", "t1-hi"]);
  });
  it("does not mutate its input", () => {
    const xs = [it_("b"), it_("a")];
    sortOrganic(xs, "price_asc");
    expect(ids(xs)).toEqual(["b", "a"]);
  });
});

describe("OpenSearch request builders", () => {
  const base = { text: "box", location: null, limit: 30 };
  it("every filter maps to a clause; MOQ keeps docs with no MOQ", () => {
    const c = filterClauses({ categoryIds: ["c1", "c2"], minTier: 2, states: ["gujarat"], cities: ["surat"], hasPrice: true, priceMinPaise: 100, priceMaxPaise: 900, maxMoq: 50 }) as any[];
    expect(c).toContainEqual({ terms: { categoryId: ["c1", "c2"] } });
    expect(c).toContainEqual({ terms: { verificationTier: ["2", "3"] } });
    expect(c).toContainEqual({ terms: { state: ["gujarat"] } });
    expect(c).toContainEqual({ terms: { city: ["surat"] } });
    expect(c).toContainEqual({ exists: { field: "pricePaise" } });
    expect(c).toContainEqual({ range: { pricePaise: { gte: 100, lte: 900 } } });
    const moq = c.find((x) => x.bool?.should);
    expect(moq.bool.should).toContainEqual({ range: { moq: { lte: 50 } } });
    expect(moq.bool.should).toContainEqual({ bool: { must_not: [{ exists: { field: "moq" } }] } });
  });
  it("no filters: request shape is unchanged (no post_filter)", () => {
    expect(buildLexicalRequest(base)).not.toHaveProperty("post_filter");
    expect(filterClauses(undefined)).toEqual([]);
  });
  it("filters narrow hits via post_filter (so facets can stay disjunctive) and the knn filter", () => {
    const q = { ...base, embedding: [0.1], filters: { minTier: 2, states: ["delhi"] } };
    const r: any = buildLexicalRequest(q, { facets: true });
    expect(r.post_filter.bool.filter).toHaveLength(2);
    expect(r.query.bool.filter).toEqual([]); // hits are narrowed after aggregation
    expect((buildKnnRequest(q) as any).query.knn.embedding.filter.bool.filter).toHaveLength(2);
    expect((buildKnnRequest({ ...q, filters: { minTier: 2 } }) as any).query.knn.embedding.filter).toEqual({ terms: { verificationTier: ["2", "3"] } });
  });
  it("aggregations leave out their own dimension's filter", () => {
    const a: any = buildAggs({ minTier: 2, states: ["delhi"] });
    expect(a.verificationTier.filter.bool.filter).toEqual([{ terms: { state: ["delhi"] } }]);
    expect(a.state.filter.bool.filter).toEqual([{ terms: { verificationTier: ["2", "3"] } }]);
    expect(a.category.filter.bool.filter).toHaveLength(2);
    expect(buildAggs().state).toEqual({ terms: { field: "state", size: 40 } });
  });
  it("parseFacets reads plain and filter-wrapped aggregations alike, including state", () => {
    const f = parseFacets({
      category: { buckets: [{ key: "packaging", doc_count: 2 }] },
      state: { doc_count: 9, v: { buckets: [{ key: "delhi", doc_count: 4 }] } },
      price: { doc_count: 9, v: { buckets: [{ key: "1k-10k", doc_count: 3 }] } },
    });
    expect(f.category).toEqual([{ key: "packaging", count: 2 }]);
    expect(f.state).toEqual([{ key: "delhi", count: 4 }]);
    expect(f.price[0]).toMatchObject({ key: "1k-10k", fromPaise: 100_000, toPaise: 1_000_000, count: 3 });
    expect(f.city).toEqual([]);
  });
});
