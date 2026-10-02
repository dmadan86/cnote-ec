import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SORTS, computeFacets, filtersSchema, matchesFilters, normaliseFilters, sortOrganic, type FilterRow, type OrganicItem, type SearchFilters } from "../src/filters";

const organic = fc.record({
  score: fc.double({ min: 0, max: 5, noNaN: true }),
  pricePaise: fc.option(fc.integer({ min: 0, max: 50_000_000 }), { nil: null }),
  publishedAtMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  tier: fc.integer({ min: 0, max: 3 }),
  trustScore: fc.integer({ min: 0, max: 100 }),
});
const items = fc.uniqueArray(fc.tuple(fc.uuid(), organic), { selector: ([id]) => id, minLength: 0, maxLength: 25 }).map((xs) => xs.map(([id, o]): OrganicItem => ({ id, ...o })));

describe("ADR-009/024: plan and ad spend never change organic order", () => {
  // The paid facts a seller could buy. They ride along on the items (as they would on a real hit) but sortOrganic must not see them.
  const paid = fc.record({ plan: fc.constantFrom("free", "growth", "pro", "enterprise"), adSpendPaise: fc.integer({ min: 0, max: 1_000_000_000 }), sponsored: fc.boolean() });

  it("any sort, any plan/ad-spend assignment: identical organic order", () =>
    fc.assert(
      fc.property(items, fc.constantFrom(...SORTS), fc.array(paid, { minLength: 25, maxLength: 25 }), fc.array(paid, { minLength: 25, maxLength: 25 }), (xs, sort, paidA, paidB) => {
        const withPaid = (ps: (typeof paidA)[number][]) => xs.map((x, i) => ({ ...x, ...ps[i]! }));
        const a = sortOrganic(withPaid(paidA), sort).map((x) => x.id);
        const b = sortOrganic(withPaid(paidB), sort).map((x) => x.id);
        const none = sortOrganic(xs, sort).map((x) => x.id);
        expect(a).toEqual(none);
        expect(b).toEqual(none);
      }),
    ));

  it("order does not depend on input order (total, deterministic)", () =>
    fc.assert(
      fc.property(items, fc.constantFrom(...SORTS), fc.nat(), (xs, sort, seed) => {
        const rotated = xs.length ? [...xs.slice(seed % xs.length), ...xs.slice(0, seed % xs.length)] : xs;
        expect(sortOrganic(rotated.reverse(), sort).map((x) => x.id)).toEqual(sortOrganic(xs, sort).map((x) => x.id));
      }),
    ));

  it("is a permutation: nothing dropped or invented", () =>
    fc.assert(fc.property(items, fc.constantFrom(...SORTS), (xs, sort) => {
      expect(sortOrganic(xs, sort).map((x) => x.id).sort()).toEqual(xs.map((x) => x.id).sort());
    })));

  it("price sorts are monotone with price-on-request last", () =>
    fc.assert(
      fc.property(items, (xs) => {
        for (const [sort, dir] of [["price_asc", 1], ["price_desc", -1]] as const) {
          const out = sortOrganic(xs, sort);
          const priced = out.filter((x) => x.pricePaise != null);
          expect(out.slice(0, priced.length)).toEqual(priced); // all priced listings come before any price-on-request one
          for (let i = 1; i < priced.length; i++) expect(dir * (priced[i]!.pricePaise! - priced[i - 1]!.pricePaise!)).toBeGreaterThanOrEqual(0);
        }
      }),
    ));

  it("trust sort never ranks a lower verification tier above a higher one", () =>
    fc.assert(
      fc.property(items, (xs) => {
        const out = sortOrganic(xs, "trust");
        for (let i = 1; i < out.length; i++) expect(out[i - 1]!.tier).toBeGreaterThanOrEqual(out[i]!.tier);
      }),
    ));
});

const rowArb = fc.record({
  categoryId: fc.constantFrom("c1", "c2", "c3"),
  categorySlug: fc.constantFrom("a", "b", "c"),
  tier: fc.integer({ min: 0, max: 3 }),
  state: fc.option(fc.constantFrom("Gujarat", "Delhi", "Kerala"), { nil: null }),
  city: fc.option(fc.constantFrom("Surat", "Delhi", "Kochi"), { nil: null }),
  pricePaise: fc.option(fc.integer({ min: 0, max: 30_000_000 }), { nil: null }),
  moq: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: null }),
});
const filtersArb: fc.Arbitrary<SearchFilters> = fc.record(
  {
    minTier: fc.integer({ min: 0, max: 3 }),
    states: fc.array(fc.constantFrom("Gujarat", "delhi", "KERALA"), { maxLength: 3 }),
    priceMinPaise: fc.integer({ min: 0, max: 1_000_000 }),
    priceMaxPaise: fc.integer({ min: 0, max: 30_000_000 }),
    maxMoq: fc.integer({ min: 1, max: 5000 }),
    hasPrice: fc.boolean(),
  },
  { requiredKeys: [] },
);

describe("filter + facet properties", () => {
  it("normaliseFilters is idempotent and always schema-valid", () =>
    fc.assert(
      fc.property(filtersArb, (f) => {
        const n = normaliseFilters(f);
        expect(normaliseFilters(n)).toEqual(n);
        expect(filtersSchema.safeParse(n).success).toBe(true);
      }),
    ));

  it("with no filters every row matches; tightening a filter never admits a row", () =>
    fc.assert(
      fc.property(rowArb, filtersArb, (r: FilterRow, f) => {
        const n = normaliseFilters(f);
        expect(matchesFilters(r, {})).toBe(true);
        if (matchesFilters(r, n)) expect(matchesFilters(r, { ...n, minTier: Math.max(0, (n.minTier ?? 0) - 1) })).toBe(true);
      }),
    ));

  it("each facet's total equals the rows matching every OTHER filter", () =>
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), filtersArb, (rows, f) => {
        const n = normaliseFilters(f);
        const facets = computeFacets(rows, n);
        const sum = (b: { count: number }[]) => b.reduce((a, x) => a + x.count, 0);
        expect(sum(facets.verificationTier)).toBe(rows.filter((r) => matchesFilters(r, n, "tier")).length);
        expect(sum(facets.state)).toBe(rows.filter((r) => matchesFilters(r, n, "state") && !!r.state).length);
        expect(sum(facets.price)).toBe(rows.filter((r) => matchesFilters(r, n, "price") && r.pricePaise != null).length);
        expect(sum(facets.category)).toBe(rows.filter((r) => matchesFilters(r, n, "category")).length);
      }),
    ));
});
