// ADR-005 / ADR-009: a seller's plan, ad spend and sponsorship never change ORGANIC rank or trust score.
// Complements filters.props.test.ts (which proves sortOrganic ignores paid fields for every sort) and properties.test.ts
// (trustFactor ignores smuggled fields): this file covers the whole pure pipeline end to end plus the trust score itself,
// and guards the source so a paid input cannot be wired in without a test failing.
import { computeTrustScore } from "@cnote/identity";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SORTS, sortOrganic, type OrganicItem } from "../src/filters";
import { organicScore, rrfFuse, type Candidate } from "../src/fusion";

const paid = fc.record({
  plan: fc.constantFrom("free", "starter", "pro", "enterprise"),
  planTier: fc.integer({ min: 0, max: 5 }),
  subscriptionActive: fc.boolean(),
  adSpendPaise: fc.integer({ min: 0, max: 5_000_000_000 }),
  walletBalancePaise: fc.integer({ min: 0, max: 5_000_000_000 }),
  sponsored: fc.boolean(),
});

const sellerArb = fc.record({
  trustScore: fc.integer({ min: 0, max: 100 }),
  badgeActive: fc.boolean(),
  city: fc.option(fc.constantFrom("Surat", "Pune", "Delhi"), { nil: null }),
  tier: fc.integer({ min: 0, max: 3 }),
});
const listingArb = fc.record({
  listingId: fc.uuid(),
  lexicalRank: fc.double({ min: 0, max: 5, noNaN: true }),
  similarity: fc.double({ min: 0, max: 1, noNaN: true }),
  seller: sellerArb,
  pricePaise: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
  publishedAtMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});
const listings = fc.uniqueArray(listingArb, { selector: (l) => l.listingId, minLength: 1, maxLength: 20 });

/** The exact composition search.ts runs: RRF -> organicScore -> sortOrganic. `paidFacts` ride along on the seller like real profile columns. */
type Row = { listingId: string; lexicalRank: number; similarity: number; seller: { trustScore: number; badgeActive: boolean; city: string | null; tier: number }; pricePaise: number | null; publishedAtMs: number };
type Paid = { plan: string; planTier: number; subscriptionActive: boolean; adSpendPaise: number; walletBalancePaise: number; sponsored: boolean };
function rank(rows: Row[], sort: (typeof SORTS)[number], hint: string | null, paidFacts?: Paid[]) {
  const cands: Candidate[] = rows.map((r) => ({ listingId: r.listingId, sellerBusinessId: r.listingId, lexicalRank: r.lexicalRank, similarity: r.similarity }));
  const fused = rrfFuse(cands);
  const items: OrganicItem[] = rows.flatMap((r, i) => {
    const rel = fused.get(r.listingId) ?? 0;
    if (rel <= 0) return [];
    const seller = paidFacts ? { ...r.seller, ...paidFacts[i % paidFacts.length]! } : r.seller;
    return [{ id: r.listingId, score: organicScore(rel, seller, hint), pricePaise: r.pricePaise, publishedAtMs: r.publishedAtMs, tier: r.seller.tier, trustScore: r.seller.trustScore }];
  });
  return sortOrganic(items, sort).map((x) => x.id);
}

describe("organic rank ignores plan, ad spend and sponsorship (whole pipeline)", () => {
  it("any sort, any paid facts: identical ranking to the same sellers with no paid facts", () =>
    fc.assert(
      fc.property(listings, fc.constantFrom(...SORTS), fc.constantFrom<string | null>(null, "surat", "pune"), fc.array(paid, { minLength: 1, maxLength: 20 }), fc.array(paid, { minLength: 1, maxLength: 20 }), (rows, sort, hint, a, b) => {
        const none = rank(rows, sort, hint);
        expect(rank(rows, sort, hint, a)).toEqual(none);
        expect(rank(rows, sort, hint, b)).toEqual(none);
      }),
      { numRuns: 300 },
    ));

  it("giving one seller the top plan, unlimited ad spend and a sponsored slot never moves any listing", () =>
    fc.assert(
      fc.property(listings, fc.constantFrom(...SORTS), (rows, sort) => {
        const base = rank(rows, sort, null);
        const maxed = rows.map((_, i) => ({ plan: "enterprise", planTier: 5, subscriptionActive: true, adSpendPaise: 5_000_000_000 * (i === 0 ? 1 : 0), walletBalancePaise: 5_000_000_000, sponsored: i === 0 }));
        expect(rank(rows, sort, null, maxed)).toEqual(base);
      }),
    ));

  it("organicScore changes only with relevance, trust score, badge and a location match", () =>
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 1, noNaN: true }), sellerArb, paid, (rel, seller, p) => {
        const clean = organicScore(rel, seller, "surat");
        expect(organicScore(rel, { ...seller, ...p } as typeof seller, "surat")).toBe(clean);
        // and it does move with the things it is allowed to see
        expect(organicScore(rel, { ...seller, trustScore: 100, badgeActive: true }, "surat")).toBeGreaterThanOrEqual(organicScore(rel, { ...seller, trustScore: 0, badgeActive: false }, "surat"));
      }),
    ));

  it("equal relevance and trust rank equal regardless of who pays: no paid tiebreak", () =>
    fc.assert(
      fc.property(sellerArb, paid, paid, (seller, p1, p2) => {
        const rel = 0.5;
        expect(organicScore(rel, { ...seller, ...p1 } as typeof seller, null)).toBe(organicScore(rel, { ...seller, ...p2 } as typeof seller, null));
      }),
    ));
});

describe("trust score ignores plan and spend (ADR-003/005)", () => {
  const signals = fc.record({
    tier: fc.integer({ min: 0, max: 3 }), acceptedFast: fc.nat(50), acceptedSlow: fc.nat(50), declined: fc.nat(50), expired: fc.nat(50),
    moderationRejections: fc.nat(10), dealsWon: fc.nat(50), disputesLost: fc.nat(10), offersBroken: fc.nat(10), inactiveDays: fc.nat(400),
  });
  it("computeTrustScore is identical with plan, ad spend or sponsorship attached", () =>
    fc.assert(fc.property(signals, paid, (s, p) => {
      expect(computeTrustScore({ ...s, ...p } as typeof s)).toEqual(computeTrustScore(s));
    })));
  it("the trust score is bounded 0..100 and the badge needs a verified tier, whatever the plan", () =>
    fc.assert(fc.property(signals, paid, (s, p) => {
      const r = computeTrustScore({ ...s, ...p } as typeof s);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      if (s.tier < 1) expect(r.badgeActive).toBe(false);
    })));
});

describe("source guard: no paid input can be wired into organic ranking or trust", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const FORBIDDEN = /\b(plan|planTier|subscription|subscriptions|adSpend\w*|walletBalance\w*|amountPaid|paid|billing)\b/i;
  const read = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), "utf8"));

  it.each(["../src/fusion.ts", "../src/filters.ts", "../src/search.ts", "../src/suggest.ts"])("%s never reads plan, spend or billing", (f) => {
    // search.ts has a semantic-planning local called `plan`; it is an embedding plan, not a subscription plan.
    const src = read(f).replace(/planSemantic|const plan = |plan\.texts|plan\.weights/g, "");
    expect(src).not.toMatch(FORBIDDEN);
  });
  it("the identity trust computation never reads plan, spend or billing", () => {
    expect(read("../../identity/src/trust.ts")).not.toMatch(FORBIDDEN);
  });
  it("search does not depend on the billing or ads modules", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toEqual(expect.arrayContaining(["@cnote/billing"]));
    expect(Object.keys(pkg.dependencies ?? {})).not.toEqual(expect.arrayContaining(["@cnote/ads"]));
  });
  it("search results are always unsponsored", () => {
    expect(read("../src/search.ts")).toMatch(/sponsored: false as const/);
    expect(read("../src/search.ts")).not.toMatch(/sponsored: true/);
  });
});
