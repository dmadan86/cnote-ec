// Benchmark publication run (ADR-022): load facts from enquiry, normalise, aggregate under k-anonymity, replace the
// period's cells in one transaction and emit PriceBenchmarkPublished. Business ids live only in memory here.
import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { listPriceFacts, type PriceFact } from "@cnote/enquiry";
import { buildCells, type Sample } from "./aggregate";
import { WINDOW_DAYS, escrowWeight, getK, priceIntelEnabled } from "./config";
import { stateFromPincode, zoneFromPincode } from "./regions";
import { normaliseFact } from "./units";

export const periodOf = (d: Date): string => d.toISOString().slice(0, 7);

export interface RunResult {
  runId: string;
  period: string;
  k: number;
  samples: number;
  skippedUnits: number;
  categories: number;
  cells: number;
  suppressedCells: number;
  suppressedReasons: { sellers: number; buyers: number; dominance: number };
}

async function loadFacts(source: "quote" | "order", since: Date, until?: Date): Promise<PriceFact[]> {
  const out: PriceFact[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof listPriceFacts>> = await listPriceFacts({ source, since, until, after, limit: 500 });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    after = page.nextCursor;
  }
}

/** Facts -> samples. An order supersedes the quote it was created from (no double counting); unknown units are skipped. */
export function toSamples(facts: readonly PriceFact[]): { samples: Sample[]; skippedUnits: number } {
  const orderedQuotes = new Set(facts.flatMap((f) => (f.source === "order" && f.quoteId ? [f.quoteId] : [])));
  const samples: Sample[] = [];
  let skippedUnits = 0;
  for (const f of facts) {
    if (f.source === "quote" && orderedQuotes.has(f.id)) continue;
    const n = normaliseFact(f.pricePaise, f.quantity, f.unit);
    if (!n) { skippedUnits++; continue; }
    samples.push({
      categoryId: f.categoryId, unit: n.unit, price: n.price, quantity: n.quantity, region: stateFromPincode(f.deliveryPincode), zone: zoneFromPincode(f.deliveryPincode),
      sellerId: f.sellerBusinessId, buyerId: f.buyerBusinessId, escrow: f.escrow,
    });
  }
  return { samples, skippedUnits };
}

/**
 * Recomputes the current period's cells over the trailing 90 days. Cells that no longer qualify are removed (privacy
 * first); a cell staff unpublished stays unpublished (its numbers refresh, its status does not).
 * The nightly trigger is a no-op while PRICE_INTEL_ENABLED is off; staff-triggered runs are not gated.
 */
export async function runBenchmarks(opts: { trigger: "nightly" | "manual"; now?: Date; k?: number } = { trigger: "manual" }): Promise<RunResult | null> {
  if (opts.trigger === "nightly" && !priceIntelEnabled()) return null;
  const now = opts.now ?? new Date();
  const period = periodOf(now);
  const k = opts.k ?? (await getK());
  const run = await prisma.priceBenchmarkRun.create({ data: { period, trigger: opts.trigger, k } });
  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
    // Only an explicit `now` (replays/tests) bounds the window above: a live run must not miss facts stamped within its own millisecond.
    const until = opts.now;
    const facts = [...(await loadFacts("quote", since, until)), ...(await loadFacts("order", since, until))];
    const { samples, skippedUnits } = toSamples(facts);
    const agg = buildCells(samples, { k, escrowWeight: escrowWeight() });
    const key = (c: { categoryId: string; unit: string; region: string; tier: string }) => `${c.categoryId}|${c.unit}|${c.region}|${c.tier}`;
    const fresh = new Set(agg.cells.map(key));

    await prisma.$transaction(async (tx) => {
      const existing = await tx.priceBenchmark.findMany({ where: { period } });
      const down = new Map(existing.filter((e) => e.status === "unpublished").map((e) => [key(e), e.id]));
      await tx.priceBenchmark.deleteMany({ where: { period, id: { notIn: [...down].filter(([kk]) => fresh.has(kk)).map(([, id]) => id) } } });
      const row = (c: (typeof agg.cells)[number]) => ({
        p10Paise: BigInt(c.p10), p25Paise: BigInt(c.p25), p50Paise: BigInt(c.p50), p75Paise: BigInt(c.p75), p90Paise: BigInt(c.p90),
        sampleCount: c.sampleCount, quoteCount: c.quoteCount, escrowCount: c.escrowCount, sellerCount: c.sellerCount, buyerCount: c.buyerCount, k, runId: run.id,
      });
      const create = agg.cells.filter((c) => !down.has(key(c)));
      for (let i = 0; i < create.length; i += 500) {
        await tx.priceBenchmark.createMany({ data: create.slice(i, i + 500).map((c) => ({ period, categoryId: c.categoryId, unit: c.unit, region: c.region, tier: c.tier, ...row(c) })) });
      }
      for (const c of agg.cells) {
        const id = down.get(key(c));
        if (id) await tx.priceBenchmark.update({ where: { id }, data: row(c) });
      }
      await tx.priceBenchmarkRun.update({
        where: { id: run.id },
        data: {
          status: "completed", samples: samples.length, categories: agg.categories, cells: agg.cells.length, suppressedCells: agg.suppressed,
          suppressedReasons: agg.reasons, finishedAt: new Date(),
        },
      });
      await emit(tx, "PriceBenchmarkPublished", { type: "price_benchmark_run", id: run.id }, { period, categories: agg.categories, cells: agg.cells.length, suppressedCells: agg.suppressed });
    });
    return { runId: run.id, period, k, samples: samples.length, skippedUnits, categories: agg.categories, cells: agg.cells.length, suppressedCells: agg.suppressed, suppressedReasons: agg.reasons };
  } catch (err) {
    await prisma.priceBenchmarkRun.update({ where: { id: run.id }, data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "failed", finishedAt: new Date() } }).catch(() => {});
    throw err;
  }
}
