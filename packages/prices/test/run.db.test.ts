import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheTags, invalidateTags } from "@cnote/core";
import { prisma } from "@cnote/db";
import { mkCategory, mkParty, mkQuote, seedQualifying, cleanup } from "./helpers";
import {
  adminSummary, getK, getPublicBenchmark, listCells, listRuns, republishCell, runBenchmarks, runNightlyIfDue, setK, unpublishCell, worker,
} from "../src/index";

afterAll(cleanup);
beforeEach(() => { process.env.PRICE_INTEL_ENABLED = "1"; });

const cellsOf = (categoryId: string) => prisma.priceBenchmark.findMany({ where: { categoryId } });

describe("runBenchmarks", () => {
  it("publishes region and national cells for a qualifying category, emits the event, and stores no business ids", async () => {
    const cat = await mkCategory("ok");
    await seedQualifying(cat.id, 6, 1000, { escrowFirst: 2 });
    const res = await runBenchmarks({ trigger: "manual", k: 5 });
    expect(res!.cells).toBeGreaterThan(0);
    const cells = await cellsOf(cat.id);
    expect(cells.map((c) => `${c.region}/${c.tier}`).sort()).toEqual(["maharashtra/all", "maharashtra/t1", "national/all", "national/t1", "pin-400/all", "pin-400/t1"]);
    const c = cells.find((x) => x.region === "national" && x.tier === "all")!;
    expect(c).toMatchObject({ unit: "kg", sampleCount: 6, escrowCount: 2, quoteCount: 4, sellerCount: 6, buyerCount: 6, k: 5, status: "published" });
    expect(Number(c.p25Paise)).toBeLessThanOrEqual(Number(c.p50Paise));
    expect(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? Number(v) : v))).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const ev = await prisma.domainEvent.findMany({ where: { type: "PriceBenchmarkPublished", aggregateId: res!.runId } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ cells: res!.cells, suppressedCells: res!.suppressedCells });
  });

  it("suppresses thin, single-buyer and dominated categories", async () => {
    const thin = await mkCategory("thin");
    await seedQualifying(thin.id, 4);
    const oneBuyer = await mkCategory("onebuyer");
    const [buyer] = await mkParty(1, false);
    const sellers = await mkParty(6, true);
    for (const s of sellers) await mkQuote({ categoryId: oneBuyer.id, buyer: buyer!, seller: s, price: 500 });
    const dom = await mkCategory("dom");
    const [bs, ss] = [await mkParty(6, false), await mkParty(6, true)];
    for (let i = 0; i < 6; i++) await mkQuote({ categoryId: dom.id, buyer: bs[i]!, seller: ss[i]!, price: 700 + i });
    for (let i = 0; i < 8; i++) await mkQuote({ categoryId: dom.id, buyer: bs[i % 6]!, seller: ss[0]!, price: 700 });
    const res = await runBenchmarks({ trigger: "manual", k: 5 });
    expect(await cellsOf(thin.id)).toHaveLength(0);
    expect(await cellsOf(oneBuyer.id)).toHaveLength(0);
    expect(await cellsOf(dom.id)).toHaveLength(0);
    expect(res!.suppressedCells).toBeGreaterThanOrEqual(3);
    expect(res!.suppressedReasons.buyers).toBeGreaterThan(0);
    expect(res!.suppressedReasons.dominance).toBeGreaterThan(0);
  });

  it("skips non-comparable units, converts comparable ones, and ignores old data", async () => {
    const cat = await mkCategory("units");
    const [bs, ss] = [await mkParty(6, false), await mkParty(6, true)];
    // per-tonne quotes normalise to per-kg
    for (let i = 0; i < 6; i++) await mkQuote({ categoryId: cat.id, buyer: bs[i]!, seller: ss[i]!, price: 5_000_000 + i, unit: "tonne", quantity: 1 });
    for (let i = 0; i < 6; i++) await mkQuote({ categoryId: cat.id, buyer: bs[i]!, seller: ss[i]!, price: 1, unit: "parsec" });
    for (let i = 0; i < 6; i++) await mkQuote({ categoryId: cat.id, buyer: bs[i]!, seller: ss[i]!, price: 1, unit: "kg", createdAt: new Date(Date.now() - 200 * 86_400_000) });
    const res = await runBenchmarks({ trigger: "manual", k: 5 });
    expect(res!.skippedUnits).toBeGreaterThanOrEqual(6);
    const cells = await cellsOf(cat.id);
    expect(cells.every((c) => c.unit === "kg")).toBe(true);
    const n = cells.find((c) => c.region === "national" && c.tier === "all")!;
    expect(Number(n.p50Paise)).toBeGreaterThan(4900);
    expect(Number(n.p50Paise)).toBeLessThan(5100);
    expect(n.sampleCount).toBe(6);
    // 1 tonne = 1000 kg falls in the t3 band
    expect(cells.some((c) => c.tier === "t3")).toBe(true);
  });

  it("a later run removes cells that stop qualifying and is otherwise idempotent", async () => {
    const cat = await mkCategory("idem");
    await seedQualifying(cat.id, 5);
    const a = await runBenchmarks({ trigger: "manual", k: 5 });
    const first = (await cellsOf(cat.id)).map((c) => `${c.region}/${c.tier}/${c.sampleCount}`).sort();
    const b = await runBenchmarks({ trigger: "manual", k: 5 });
    expect((await cellsOf(cat.id)).map((c) => `${c.region}/${c.tier}/${c.sampleCount}`).sort()).toEqual(first);
    expect(b!.cells).toBe(a!.cells);
    await runBenchmarks({ trigger: "manual", k: 6 });
    expect(await cellsOf(cat.id)).toHaveLength(0);
  });

  it("nightly is a no-op with the flag off; runNightlyIfDue runs once per day", async () => {
    process.env.PRICE_INTEL_ENABLED = "0";
    expect(await runBenchmarks({ trigger: "nightly" })).toBeNull();
    expect(await runNightlyIfDue()).toBe(false);
    process.env.PRICE_INTEL_ENABLED = "1";
    await prisma.priceBenchmarkRun.deleteMany({});
    expect(await runNightlyIfDue()).toBe(true);
    expect(await runNightlyIfDue()).toBe(false);
    expect(worker.name).toBe("prices");
    await worker.jobs[0]!.run();
    expect((await listRuns(5)).length).toBeGreaterThan(0);
  });

  it("marks the run failed and rethrows when aggregation blows up", async () => {
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("boom"));
    try { await expect(runBenchmarks({ trigger: "manual", k: 5 })).rejects.toThrow("boom"); } finally { spy.mockRestore(); }
    const [latest] = await listRuns(1);
    expect(latest).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("pincode zone cells and roll-up (zone -> state -> national)", () => {
  it("publishes a zone cell only when the zone itself has k sellers and buyers; the state cell still covers the thin zone", async () => {
    const cat = await mkCategory("zones");
    // Mumbai zone (400) has 6 independent parties; Pune zone (411) only 3 more: state Maharashtra reaches 9, Pune zone stays below k
    await seedQualifying(cat.id, 6, 1000, { quantity: 50, pincode: "400001" });
    const [pb, ps] = [await mkParty(3, false), await mkParty(3, true)];
    for (let i = 0; i < 3; i++) await mkQuote({ categoryId: cat.id, buyer: pb[i]!, seller: ps[i]!, price: 1100, quantity: 50, pincode: "411001" });
    await runBenchmarks({ trigger: "manual", k: 5 });
    const regions = [...new Set((await cellsOf(cat.id)).map((c) => c.region))].sort();
    expect(regions).toEqual(["maharashtra", "national", "pin-400"]);
    const pune = await getPublicBenchmark({ categoryId: cat.id, quantity: 60, unit: "kg", pincode: "411001" });
    expect(pune!.scope).toMatchObject({ region: "maharashtra", regionLabel: "Maharashtra", rolledUp: true, volume: "band" });
    expect(pune!.sampleCount).toBe(9);
    const mumbai = await getPublicBenchmark({ categoryId: cat.id, quantity: 60, unit: "kg", pincode: "400099" });
    expect(mumbai!.scope).toMatchObject({ region: "pin-400", rolledUp: false });
    // unmapped / APS pincode falls back to national
    const aps = await getPublicBenchmark({ categoryId: cat.id, quantity: 60, unit: "kg", pincode: "900001" });
    expect(aps!.scope).toMatchObject({ region: "national", rolledUp: false });
  });

  it("a zone cell dominated by one seller is suppressed and falls back to the state cell", async () => {
    const cat = await mkCategory("zone-dominance");
    await seedQualifying(cat.id, 10, 1000, { quantity: 50, pincode: "560001" }); // Bengaluru zone, healthy
    const [pb, ps] = [await mkParty(8, false), await mkParty(1, true)];
    for (let i = 0; i < 8; i++) await mkQuote({ categoryId: cat.id, buyer: pb[i]!, seller: ps[0]!, price: 1005, quantity: 50, pincode: "570001" }); // Mysuru zone, one seller
    await runBenchmarks({ trigger: "manual", k: 5 });
    expect(new Set((await cellsOf(cat.id)).map((c) => c.region))).not.toContain("pin-570");
    const r = await getPublicBenchmark({ categoryId: cat.id, quantity: 60, unit: "kg", pincode: "570001" });
    expect(r!.scope.region).toBe("karnataka");
  });
});

describe("public lookup and roll-up", () => {
  it("returns the state band, rolls up to national, converts units, hides everything with the flag off", async () => {
    const cat = await mkCategory("lookup");
    await seedQualifying(cat.id, 6, 1000, { quantity: 50 });
    // 4 Gujarat quotes: too thin for a Gujarat cell
    const [gb, gs] = [await mkParty(4, false), await mkParty(4, true)];
    for (let i = 0; i < 4; i++) await mkQuote({ categoryId: cat.id, buyer: gb[i]!, seller: gs[i]!, price: 3000, quantity: 50, pincode: "380001" });
    await runBenchmarks({ trigger: "manual", k: 5 });

    const mh = await getPublicBenchmark({ categoryId: cat.id, quantity: 60, unit: "kg", pincode: "400050" });
    expect(mh).toMatchObject({ indicative: true, unit: "kg", scope: { region: "pin-400", regionLabel: "PIN 400xxx", volume: "band", rolledUp: false }, sampleCount: 6 });
    expect(mh!.p25Paise).toBeLessThanOrEqual(mh!.medianPaise);
    expect(mh!.medianPaise).toBeLessThanOrEqual(mh!.p75Paise);
    expect(Object.keys(mh!).sort()).toEqual(["indicative", "medianPaise", "p25Paise", "p75Paise", "period", "sampleCount", "scope", "trendBps", "unit"]);

    const gj = await getPublicBenchmark({ categoryId: cat.id, quantity: 60, unit: "kg", pincode: "380001" });
    expect(gj!.scope).toMatchObject({ region: "national", rolledUp: true });
    // different volume band with no data rolls up to all volumes
    const big = await getPublicBenchmark({ categoryId: cat.id, quantity: 5000, unit: "kg", state: "Maharashtra" });
    expect(big!.scope).toMatchObject({ region: "maharashtra", volume: "all", rolledUp: true });
    const bigZone = await getPublicBenchmark({ categoryId: cat.id, quantity: 5000, unit: "kg", pincode: "400001" });
    expect(bigZone!.scope).toMatchObject({ region: "pin-400", volume: "all", rolledUp: true });
    // unit conversion: per-kg -> per-tonne
    const tonne = await getPublicBenchmark({ categoryId: cat.id, quantity: 1, unit: "tonne", pincode: "400001" });
    expect(tonne!.unit).toBe("tonne");
    expect(tonne!.medianPaise).toBeGreaterThan(mh!.medianPaise * 900);
    // no unit given: uses the category's unit
    expect((await getPublicBenchmark({ categoryId: cat.id }))!.unit).toBe("kg");
    // unknown category / not comparable unit
    expect(await getPublicBenchmark({ categoryId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    expect(await getPublicBenchmark({})).toBeNull();
    expect(await getPublicBenchmark({ categoryId: cat.id, unit: "set" })).toBeNull();
    process.env.PRICE_INTEL_ENABLED = "0";
    expect(await getPublicBenchmark({ categoryId: cat.id })).toBeNull();
  });

  it("resolves a category slug and reports a trend against the previous period", async () => {
    const cat = await mkCategory("trend");
    await seedQualifying(cat.id, 6, 2000);
    await runBenchmarks({ trigger: "manual", k: 5 });
    const now = await prisma.priceBenchmark.findMany({ where: { categoryId: cat.id } });
    const period = now[0]!.period;
    const prev = "2000-01";
    await prisma.priceBenchmark.createMany({ data: now.map(({ id: _id, ...c }) => ({ ...c, period: prev, p50Paise: c.p50Paise / 2n })) });
    await invalidateTags([cacheTags.categories]);
    const r = await getPublicBenchmark({ categorySlug: cat.slug, unit: "kg", quantity: 10 });
    expect(r!.period).toBe(period);
    expect(r!.trendBps).toBeGreaterThan(9000);
  });
});

describe("admin controls", () => {
  it("unpublish hides a cell, survives re-runs, and republish restores it", async () => {
    const cat = await mkCategory("admin");
    await seedQualifying(cat.id, 6, 900);
    await runBenchmarks({ trigger: "manual", k: 5 });
    const cells = await listCells({ categoryId: cat.id, status: "published" });
    expect(cells.length).toBe(6);
    expect(cells[0]!.categoryName).toContain("admin");
    const target = cells.find((c) => c.region === "national" && c.tier === "all")!;
    await expect(unpublishCell(target.id, null, "x")).rejects.toMatchObject({ code: "validation" });
    await expect(unpublishCell("00000000-0000-4000-8000-000000000000", null, "bad data")).rejects.toMatchObject({ code: "not_found" });
    await unpublishCell(target.id, null, "suspected manipulation");
    await runBenchmarks({ trigger: "manual", k: 5 });
    const after = await listCells({ categoryId: cat.id });
    expect(after.find((c) => c.id === target.id)).toMatchObject({ status: "unpublished", unpublishedReason: "suspected manipulation" });
    expect(await getPublicBenchmark({ categoryId: cat.id, unit: "kg" })).toBeNull(); // the only coarse cell is down
    const hit = await getPublicBenchmark({ categoryId: cat.id, unit: "kg", pincode: "400001" });
    expect(hit!.scope.region).toBe("pin-400");
    const s = await adminSummary();
    expect(s.unpublishedCells).toBeGreaterThan(0);
    expect(s.latest?.status).toBe("completed");
    await republishCell(target.id);
    await expect(republishCell(target.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await listCells({ categoryId: cat.id, status: "published" })).length).toBe(6);
  });

  it("k config is bounded and drives runs", async () => {
    expect(await getK({})).toBe(5);
    await expect(setK(2, null)).rejects.toMatchObject({ code: "validation" });
    await expect(setK(1.5, null)).rejects.toMatchObject({ code: "validation" });
    await setK(8, null);
    expect(await getK()).toBe(8);
    const cat = await mkCategory("kcfg");
    await seedQualifying(cat.id, 6);
    const r = await runBenchmarks({ trigger: "manual" });
    expect(r!.k).toBe(8);
    expect(await cellsOf(cat.id)).toHaveLength(0);
    await prisma.priceConfig.deleteMany({});
    expect(await getK({ PRICE_K: "4" })).toBe(4);
    expect(await getK({ PRICE_K: "zz" })).toBe(5);
  });
});
