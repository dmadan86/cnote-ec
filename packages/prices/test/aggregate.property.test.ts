import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCells, evaluateCell, type Sample } from "../src/aggregate";
import { weightedPercentile } from "../src/stats";

const REGIONS = [null, "maharashtra", "karnataka", "gujarat"] as const;
const sample = fc.record({
  categoryId: fc.constantFrom("c1", "c2"),
  unit: fc.constantFrom("kg", "pcs"),
  price: fc.integer({ min: 1, max: 1_000_000 }),
  quantity: fc.integer({ min: 1, max: 5000 }),
  region: fc.constantFrom(...REGIONS),
  sellerId: fc.constantFrom("s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"),
  buyerId: fc.constantFrom("b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"),
  escrow: fc.boolean(),
}) as fc.Arbitrary<Sample>;
const samples = fc.array(sample, { minLength: 0, maxLength: 120 });
const kArb = fc.integer({ min: 2, max: 7 });
const opts = (k: number, escrowWeight = 3) => ({ k, escrowWeight });

describe("k-anonymity properties", () => {
  it("never publishes a cell violating k, dominance or ordering, for any dataset", () => {
    fc.assert(fc.property(samples, kArb, (data, k) => {
      const res = buildCells(data, opts(k));
      for (const c of res.cells) {
        expect(c.sellerCount).toBeGreaterThanOrEqual(k);
        expect(c.buyerCount).toBeGreaterThanOrEqual(k);
        expect(c.sampleCount).toBeGreaterThanOrEqual(k);
        expect(c.quoteCount + c.escrowCount).toBe(c.sampleCount);
        expect(c.p10).toBeLessThanOrEqual(c.p25);
        expect(c.p25).toBeLessThanOrEqual(c.p50);
        expect(c.p50).toBeLessThanOrEqual(c.p75);
        expect(c.p75).toBeLessThanOrEqual(c.p90);
      }
      expect(res.suppressed + res.cells.length).toBe(res.evaluated);
      expect(res.reasons.sellers + res.reasons.buyers + res.reasons.dominance).toBe(res.suppressed);
    }), { numRuns: 300 });
  });

  it("independently re-verifies every published cell from the samples it used (incl. dominance <= 50%)", () => {
    fc.assert(fc.property(samples, kArb, (data, k) => {
      const r = evaluateCell(data, opts(k));
      if (!r.ok) return;
      const per = new Map<string, number>();
      for (const s of r.used) per.set(s.sellerId, (per.get(s.sellerId) ?? 0) + 1);
      expect(per.size).toBeGreaterThanOrEqual(k);
      expect(new Set(r.used.map((s) => s.buyerId)).size).toBeGreaterThanOrEqual(k);
      expect(Math.max(...per.values()) * 2).toBeLessThanOrEqual(r.used.length);
      const prices = r.used.map((s) => s.price);
      expect(r.cell.p50).toBeGreaterThanOrEqual(Math.min(...prices));
      expect(r.cell.p50).toBeLessThanOrEqual(Math.max(...prices));
    }), { numRuns: 300 });
  });

  it("suppresses any cell with fewer than k sellers or buyers, or a dominant seller", () => {
    fc.assert(fc.property(samples, kArb, (data, k) => {
      const lowSellers = data.map((s) => ({ ...s, categoryId: "c1", unit: "kg", region: null, sellerId: s.sellerId === "s1" || s.sellerId === "s2" ? s.sellerId : "s1" }));
      const distinct = new Set(lowSellers.map((s) => s.sellerId)).size;
      if (distinct < k) expect(evaluateCell(lowSellers, opts(k)).ok).toBe(false);
      const oneBuyer = data.map((s) => ({ ...s, buyerId: "b1" }));
      if (oneBuyer.length > 0) expect(evaluateCell(oneBuyer, opts(k)).ok).toBe(false);
      const dominated = [...data.filter((s) => s.sellerId !== "s1"), ...data.map((s) => ({ ...s, sellerId: "s1" })), ...data.map((s) => ({ ...s, sellerId: "s1" }))];
      const r = evaluateCell(dominated, opts(k));
      if (r.ok) { const n = r.used.filter((s) => s.sellerId === "s1").length; expect(n * 2).toBeLessThanOrEqual(r.used.length); }
    }), { numRuns: 200 });
  });

  it("cells never carry counterparty ids", () => {
    fc.assert(fc.property(samples, kArb, (data, k) => {
      const json = JSON.stringify(buildCells(data, opts(k)));
      expect(json).not.toMatch(/"(sellerId|buyerId|sellerBusinessId|buyerBusinessId)"/);
      expect(json).not.toMatch(/"[sb][1-8]"/);
    }), { numRuns: 200 });
  });

  it("is order independent", () => {
    fc.assert(fc.property(samples, kArb, (data, k) => {
      const a = buildCells(data, opts(k));
      const b = buildCells([...data].reverse(), opts(k));
      const norm = (r: typeof a) => JSON.stringify([...r.cells].sort((x, y) => `${x.categoryId}${x.unit}${x.region}${x.tier}`.localeCompare(`${y.categoryId}${y.unit}${y.region}${y.tier}`)));
      expect(norm(a)).toBe(norm(b));
    }), { numRuns: 100 });
  });
});

describe("percentile properties", () => {
  it("equals nearest-rank for unit weights and stays within min/max", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 200 }), fc.double({ min: 0, max: 1, noNaN: true }), (vals, q) => {
      const sorted = [...vals].sort((a, b) => a - b).map((value) => ({ value, weight: 1 }));
      const got = weightedPercentile(sorted, q);
      const rank = Math.max(1, Math.ceil(q * sorted.length - 1e-9));
      expect(got).toBe(sorted[rank - 1]!.value);
      expect(got).toBeGreaterThanOrEqual(sorted[0]!.value);
      expect(got).toBeLessThanOrEqual(sorted[sorted.length - 1]!.value);
    }), { numRuns: 300 });
  });
  it("is monotone in q", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 1, max: 5 })), { minLength: 1, maxLength: 60 }), (pairs) => {
      const sorted = pairs.map(([value, weight]) => ({ value, weight })).sort((a, b) => a.value - b.value);
      let prev = -Infinity;
      for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) { const v = weightedPercentile(sorted, q); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    }), { numRuns: 200 });
  });
});

describe("aggregate examples", () => {
  const mk = (i: number, o: Partial<Sample> = {}): Sample => ({ categoryId: "c", unit: "kg", price: 100 + i, quantity: 50, region: "maharashtra", sellerId: `s${i}`, buyerId: `b${i}`, escrow: false, ...o });
  it("publishes region, national, band and all cells when everything qualifies", () => {
    const res = buildCells(Array.from({ length: 6 }, (_, i) => mk(i)), opts(5));
    const keys = res.cells.map((c) => `${c.region}/${c.tier}`).sort();
    expect(keys).toEqual(["maharashtra/all", "maharashtra/t1", "national/all", "national/t1"]);
    expect(res.categories).toBe(1);
  });
  it("suppresses a thin region but keeps the national roll-up", () => {
    const data = [...Array.from({ length: 4 }, (_, i) => mk(i)), ...Array.from({ length: 4 }, (_, i) => mk(i + 4, { region: "gujarat" }))];
    const res = buildCells(data, opts(5));
    expect(res.cells.map((c) => c.region)).toEqual(["national", "national"]);
    expect(res.suppressed).toBe(4);
    expect(res.reasons.sellers).toBe(4);
  });
  it("counts buyer and dominance suppression separately", () => {
    const oneBuyer = Array.from({ length: 6 }, (_, i) => mk(i, { buyerId: "b" }));
    expect(evaluateCell(oneBuyer, opts(5))).toEqual({ ok: false, reason: "buyers" });
    const dom = [...Array.from({ length: 5 }, (_, i) => mk(i)), ...Array.from({ length: 6 }, (_, i) => mk(i + 10, { sellerId: "s0", buyerId: `b${i}` }))];
    expect(evaluateCell(dom, opts(5))).toEqual({ ok: false, reason: "dominance" });
  });
  it("weights escrow samples above quotes", () => {
    const quotes = Array.from({ length: 5 }, (_, i) => mk(i, { price: 100 }));
    const escrow = Array.from({ length: 5 }, (_, i) => mk(i + 5, { price: 200, escrow: true }));
    const r = evaluateCell([...quotes, ...escrow], opts(5, 3));
    expect(r.ok && r.cell.p50).toBe(200);
    expect(r.ok && r.cell.escrowCount).toBe(5);
    const flat = evaluateCell([...quotes, ...escrow], opts(5, 1));
    expect(flat.ok && flat.cell.p50).toBe(100);
  });
  it("trims outliers before counting distinct sellers", () => {
    const data = [...Array.from({ length: 8 }, (_, i) => mk(i % 5, { buyerId: `b${i}`, price: 100 + i })), mk(20, { price: 9_000_000, buyerId: "b20" })];
    const r = evaluateCell(data, opts(5));
    expect(r.ok && r.cell.p90).toBeLessThan(1000);
  });
});
