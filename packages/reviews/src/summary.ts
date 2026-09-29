import { prisma, type Tx } from "@cnote/db";
import type { RatingSummary } from "./types";

const EMPTY = [0, 0, 0, 0, 0] as RatingSummary["histogram"];

function toView(listingId: string, row: { ratingCount: number; ratingSum: number; histogram: number[] } | null | undefined): RatingSummary {
  if (!row || row.ratingCount === 0) return { listingId, count: 0, average: 0, histogram: [...EMPTY] as RatingSummary["histogram"] };
  const h = [0, 1, 2, 3, 4].map((i) => row.histogram[i] ?? 0) as RatingSummary["histogram"];
  return { listingId, count: row.ratingCount, average: Math.round((row.ratingSum / row.ratingCount) * 10) / 10, histogram: h };
}

/**
 * Recompute the aggregate from approved rows only. Called inside the same transaction as every
 * approve/reject/edit/re-flag. The advisory lock serialises concurrent recomputes per listing, so
 * a slower transaction can't overwrite a newer aggregate with stale counts.
 */
export async function recomputeSummary(tx: Tx, listingId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"rating:" + listingId}))`;
  const groups = await tx.productReview.groupBy({ by: ["rating"], where: { listingId, status: "approved" }, _count: { _all: true } });
  const histogram = [0, 0, 0, 0, 0];
  let sum = 0;
  let count = 0;
  for (const g of groups) {
    if (g.rating < 1 || g.rating > 5) continue;
    histogram[g.rating - 1] = g._count._all;
    sum += g.rating * g._count._all;
    count += g._count._all;
  }
  await tx.listingRatingSummary.upsert({
    where: { listingId },
    create: { listingId, ratingCount: count, ratingSum: sum, histogram },
    update: { ratingCount: count, ratingSum: sum, histogram },
  });
}

export async function getRatingSummary(listingId: string): Promise<RatingSummary> {
  return toView(listingId, await prisma.listingRatingSummary.findUnique({ where: { listingId } }));
}

/** One entry per requested id (zero-count summary when unrated). For product cards and search results. */
export async function getRatingSummaries(listingIds: string[]): Promise<Map<string, RatingSummary>> {
  const ids = [...new Set(listingIds)];
  if (!ids.length) return new Map();
  const rows = await prisma.listingRatingSummary.findMany({ where: { listingId: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.listingId, r]));
  return new Map(ids.map((id) => [id, toView(id, byId.get(id))]));
}
