// ADR-002 / ADR-005 / ADR-009: lead matching order is similarity x reliability x geo. A seller's plan, ad spend, wallet or
// sponsorship never moves them up (or down). ADR-002 lists exactly three match factors and no capacity or payment factor, so the
// only order-changing input beyond them is the buyer's own "started from this seller's listing" preference.
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assignSlots, rankCandidates, type Candidate, type SellerSignals } from "../src/scoring";

const paid = fc.record({
  plan: fc.constantFrom("free", "starter", "pro", "enterprise"),
  planTier: fc.integer({ min: 0, max: 5 }),
  subscriptionActive: fc.boolean(),
  adSpendPaise: fc.integer({ min: 0, max: 5_000_000_000 }),
  walletBalancePaise: fc.integer({ min: 0, max: 5_000_000_000 }),
  creditsRemaining: fc.integer({ min: 0, max: 10_000 }),
  sponsored: fc.boolean(),
});

const signals: fc.Arbitrary<SellerSignals> = fc.record({
  trustScore: fc.integer({ min: 0, max: 100 }),
  verificationTier: fc.integer({ min: 0, max: 3 }),
  badgeActive: fc.boolean(),
  city: fc.option(fc.constantFrom("Pune", "Delhi", "Surat"), { nil: null }),
  state: fc.option(fc.constantFrom("MH", "DL", "GJ"), { nil: null }),
  pincode: fc.option(fc.constantFrom("411001", "110001", "395003"), { nil: null }),
});
const geo = fc.record({ city: fc.option(fc.constantFrom("Pune", "Delhi"), { nil: null }), state: fc.option(fc.constantFrom("MH", "DL"), { nil: null }), pincode: fc.option(fc.constantFrom("411001", "110001"), { nil: null }) });

const field = fc.uniqueArray(
  fc.record({ id: fc.uuid(), sim: fc.double({ min: 0, max: 1, noNaN: true }), s: signals }),
  { selector: (x) => x.id, minLength: 1, maxLength: 25 },
);

const toCands = (xs: { id: string; sim: number }[]): Candidate[] => xs.map((x) => ({ sellerBusinessId: x.id, listingId: `l-${x.id}`, similarity: x.sim }));

describe("lead matching order never depends on plan, spend or sponsorship", () => {
  it("any paid facts attached to sellers: identical ranked order and scores", () =>
    fc.assert(
      fc.property(field, geo, fc.array(paid, { minLength: 1, maxLength: 25 }), fc.array(paid, { minLength: 1, maxLength: 25 }), (xs, buyer, pa, pb) => {
        const plain = new Map(xs.map((x) => [x.id, x.s]));
        const withPaid = (ps: (typeof pa)[number][]) => new Map(xs.map((x, i) => [x.id, { ...x.s, ...ps[i % ps.length]! } as SellerSignals]));
        const base = rankCandidates(toCands(xs), plain, buyer);
        expect(rankCandidates(toCands(xs), withPaid(pa), buyer)).toEqual(base);
        expect(rankCandidates(toCands(xs), withPaid(pb), buyer)).toEqual(base);
      }),
      { numRuns: 300 },
    ));

  it("a seller who pays the most never gains a rank, and the order is exactly match score descending", () =>
    fc.assert(
      fc.property(field, geo, (xs, buyer) => {
        const profiles = new Map(xs.map((x, i) => [x.id, { ...x.s, plan: i === 0 ? "enterprise" : "free", adSpendPaise: i === 0 ? 9e9 : 0, sponsored: i === 0 } as SellerSignals]));
        const ranked = rankCandidates(toCands(xs), profiles, buyer);
        for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.matchScore).toBeGreaterThanOrEqual(ranked[i]!.matchScore);
        const free = rankCandidates(toCands(xs), new Map(xs.map((x) => [x.id, x.s])), buyer);
        expect(ranked.map((r) => r.sellerBusinessId)).toEqual(free.map((r) => r.sellerBusinessId));
      }),
    ));

  it("the only sanctioned reorder is the buyer's own preferred seller, and it is not influenced by payment", () =>
    fc.assert(
      fc.property(field, geo, fc.nat(), fc.array(paid, { minLength: 1, maxLength: 25 }), (xs, buyer, pick, ps) => {
        const preferred = xs[pick % xs.length]!.id;
        const plain = new Map(xs.map((x) => [x.id, x.s]));
        const paidMap = new Map(xs.map((x, i) => [x.id, { ...x.s, ...ps[i % ps.length]! } as SellerSignals]));
        const a = rankCandidates(toCands(xs), plain, buyer, { preferredSellerId: preferred });
        const b = rankCandidates(toCands(xs), paidMap, buyer, { preferredSellerId: preferred });
        expect(b).toEqual(a);
        expect(a[0]!.sellerBusinessId).toBe(preferred);
        // everyone else keeps pure score order
        const rest = a.slice(1).map((r) => r.matchScore);
        expect([...rest].sort((p, q) => q - p)).toEqual(rest);
      }),
    ));

  it("cascade slot assignment depends only on the ranked list and free ranks", () =>
    fc.assert(
      fc.property(field, geo, fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 5 }), fc.integer({ min: 1, max: 5 }), fc.array(paid, { minLength: 1, maxLength: 25 }), (xs, buyer, active, cap, ps) => {
        const plain = rankCandidates(toCands(xs), new Map(xs.map((x) => [x.id, x.s])), buyer);
        const paidRanked = rankCandidates(toCands(xs), new Map(xs.map((x, i) => [x.id, { ...x.s, ...ps[i % ps.length]! } as SellerSignals])), buyer);
        expect(assignSlots(paidRanked, active, cap)).toEqual(assignSlots(plain, active, cap));
      }),
    ));
});

describe("source guard: matching reads no plan, billing or spend", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const read = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const FORBIDDEN = /\b(plan|planTier|subscription|subscriptions|adSpend\w*|walletBalance\w*|amountPaid|paid|billing|credits?|sponsored)\b/i;

  it.each(["../src/scoring.ts", "../src/matching.ts"])("%s never references plan, billing, credits or sponsorship", (f) => {
    expect(read(f)).not.toMatch(FORBIDDEN);
  });
  it("the seller profile matching ranks on carries no paid field", () => {
    const types = readFileSync(new URL("../../identity/src/types.ts", import.meta.url), "utf8");
    const profile = /export interface TrustProfile \{([^}]*)\}/.exec(types)![1]!;
    expect(strip(profile)).not.toMatch(FORBIDDEN);
    expect(Object.keys(signalsShape())).toEqual(["trustScore", "verificationTier", "badgeActive", "city", "state", "pincode"]);
  });
});

function signalsShape(): Record<keyof SellerSignals, true> {
  return { trustScore: true, verificationTier: true, badgeActive: true, city: true, state: true, pincode: true };
}
