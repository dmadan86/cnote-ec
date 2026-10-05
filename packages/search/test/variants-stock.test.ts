import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeFacets, filtersSchema, hasActiveFilters, matchesFilters, normaliseFilters, sortOrganic, variantKeysOf, type FilterRow, type OrganicItem } from "../src/filters";
import { buildAggs, buildKnnRequest, buildLexicalRequest, filterClauses } from "../src/index-port/query";
import { buildIndexBody, toSourceDoc } from "../src/index-port/mapping";
import { parseFacets } from "../src/index-port/opensearch";
import type { IndexDoc } from "../src/index-port/types";

const row = (o: Partial<FilterRow> = {}): FilterRow => ({ categoryId: "c", tier: 1, state: "x", city: "y", pricePaise: 100, moq: 1, inStock: true, variantValues: [], ...o });

describe("filters: in stock only + variant options", () => {
  it("schema accepts them and rejects absurd shapes", () => {
    expect(filtersSchema.safeParse({ inStockOnly: true, variantOptions: { size: ["M", "L"], colour: ["red"] } }).success).toBe(true);
    expect(filtersSchema.safeParse({ variantOptions: { size: [""] } }).success).toBe(false);
    expect(filtersSchema.safeParse({ variantOptions: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`a${i}`, ["x"]])) }).success).toBe(false);
  });

  it("normalises to a stable, lower-cased, sorted form and drops neutral values", () => {
    expect(normaliseFilters({ inStockOnly: false, variantOptions: {} })).toEqual({});
    const n = normaliseFilters({ inStockOnly: true, variantOptions: { Size: ["XL", "m", "M"], colour: ["Red"], empty: [] } });
    expect(n).toEqual({ inStockOnly: true, variantOptions: { colour: ["red"], size: ["m", "xl"] } });
    expect(normaliseFilters({ variantOptions: { size: ["m", "xl"] } })).toEqual(normaliseFilters({ variantOptions: { SIZE: ["XL", "M"] } })); // same cache key
    expect(hasActiveFilters(n)).toBe(true);
  });

  it("inStockOnly keeps only in_stock rows (made-to-order does not count)", () => {
    expect(matchesFilters(row({ inStock: true }), { inStockOnly: true })).toBe(true);
    expect(matchesFilters(row({ inStock: false }), { inStockOnly: true })).toBe(false);
    expect(matchesFilters(row({ inStock: undefined }), { inStockOnly: true })).toBe(false);
    expect(matchesFilters(row({ inStock: false }), {})).toBe(true);
  });

  it("variant options: OR within an axis, AND across axes", () => {
    const r = row({ variantValues: ["colour:red", "size:m"] });
    expect(matchesFilters(r, { variantOptions: { size: ["m", "l"] } })).toBe(true);
    expect(matchesFilters(r, { variantOptions: { size: ["l"] } })).toBe(false);
    expect(matchesFilters(r, { variantOptions: { size: ["m"], colour: ["red"] } })).toBe(true);
    expect(matchesFilters(r, { variantOptions: { size: ["m"], colour: ["blue"] } })).toBe(false);
    expect(matchesFilters(r, { variantOptions: { size: ["l"] } }, "variant")).toBe(true); // the facet ignores its own filters
  });

  it("variant facet counts ignore variant filters but respect the others", () => {
    const rows = [
      row({ variantValues: ["size:m", "colour:red"] }),
      row({ variantValues: ["size:l", "colour:red"] }),
      row({ variantValues: ["size:l"], inStock: false }),
    ];
    expect(computeFacets(rows, {}).variant).toEqual([{ key: "colour:red", count: 2 }, { key: "size:l", count: 2 }, { key: "size:m", count: 1 }]);
    const f = computeFacets(rows, { variantOptions: { size: ["m"] }, inStockOnly: true });
    expect(f.variant).toEqual([{ key: "colour:red", count: 2 }, { key: "size:l", count: 1 }, { key: "size:m", count: 1 }]);
  });

  it("variantKeysOf matches the live row's keys", () => {
    expect(variantKeysOf([{ axisValues: { Size: "M", colour: "Red" } }, { axisValues: { Size: "L", colour: "Red" } }])).toEqual(["colour:red", "size:l", "size:m"]);
    expect(variantKeysOf(undefined)).toEqual([]);
  });
});

describe("ADR-009/024: stock and variants are filters, never ranking inputs", () => {
  const organic = fc.record({
    score: fc.double({ min: 0, max: 5, noNaN: true }),
    pricePaise: fc.option(fc.integer({ min: 0, max: 50_000_000 }), { nil: null }),
    publishedAtMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    tier: fc.integer({ min: 0, max: 3 }),
    trustScore: fc.integer({ min: 0, max: 100 }),
  });
  const items = fc.uniqueArray(fc.tuple(fc.uuid(), organic, fc.boolean(), fc.constantFrom("in_stock", "made_to_order", "out_of_stock")), { selector: ([id]) => id, maxLength: 25 });

  it("attaching stock facts never changes the order; filtering by stock keeps the relative order of the survivors", () =>
    fc.assert(
      fc.property(items, fc.constantFrom("relevance", "price_asc", "price_desc", "newest", "trust" as const), (xs, sort) => {
        const plain: OrganicItem[] = xs.map(([id, o]) => ({ id, ...o }));
        const withStock = xs.map(([id, o, inStock, availability]) => ({ id, ...o, inStock, availability }));
        const full = sortOrganic(plain, sort).map((x) => x.id);
        expect(sortOrganic(withStock, sort).map((x) => x.id)).toEqual(full);
        const keep = new Set(xs.filter(([, , inStock]) => inStock).map(([id]) => id));
        expect(sortOrganic(withStock.filter((x) => keep.has(x.id)), sort).map((x) => x.id)).toEqual(full.filter((id) => keep.has(id)));
      }),
    ));
});

describe("OpenSearch builders", () => {
  it("filter clauses: stock term, one terms clause per variant axis, and the variant dimension is skippable", () => {
    const f = { inStockOnly: true, variantOptions: { size: ["m", "l"], colour: ["red"] } };
    expect(filterClauses(f)).toEqual([
      { terms: { variantValues: ["size:m", "size:l"] } },
      { terms: { variantValues: ["colour:red"] } },
      { term: { availability: "in_stock" } },
    ]);
    expect(filterClauses(f, "variant")).toEqual([{ term: { availability: "in_stock" } }]);
    expect(filterClauses({})).toEqual([]);
  });

  it("requests carry the filters (post_filter for lexical, filter for kNN) and the variant aggregation", () => {
    const q = { text: "shirt", location: null, limit: 10, embedding: [0.1], filters: { inStockOnly: true } } as never;
    expect(JSON.stringify(buildLexicalRequest(q, { facets: true }))).toContain('"availability":"in_stock"');
    expect(JSON.stringify(buildKnnRequest(q))).toContain('"availability":"in_stock"');
    const aggs = buildAggs({ inStockOnly: true }) as Record<string, any>;
    expect(aggs.variant.aggs.v.terms).toEqual({ field: "variantValues", size: 60 });
    expect((buildAggs() as Record<string, any>).variant).toEqual({ terms: { field: "variantValues", size: 60 } });
    expect(parseFacets({ category: {}, city: {}, state: {}, verificationTier: {}, price: {}, variant: { buckets: [{ key: "size:m", doc_count: 3 }] } }).variant).toEqual([{ key: "size:m", count: 3 }]);
  });

  it("the index maps and stores availability + variant values (strict mapping)", () => {
    const props = buildIndexBody({ icu: false, synonyms: [] }).mappings.properties as Record<string, unknown>;
    expect(props.availability).toEqual({ type: "keyword" });
    expect(props.variantValues).toEqual({ type: "keyword" });
    const doc = { listingId: "1", sellerBusinessId: "s", categoryId: "c", categorySlug: "c", categoryName: "C", title: "T", description: "", city: null, state: null, verificationTier: 1, trustScore: 1, badgeActive: false, pricePaise: null, moq: null, updatedAt: "now" } as IndexDoc;
    expect(toSourceDoc(doc)).toMatchObject({ availability: "in_stock", variantValues: [] });
    expect(toSourceDoc({ ...doc, availability: "out_of_stock", variantValues: ["size:m"] })).toMatchObject({ availability: "out_of_stock", variantValues: ["size:m"] });
  });
});
