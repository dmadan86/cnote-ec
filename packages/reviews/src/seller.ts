// Public, seller-level review reads for the supplier profile and seller card. Approved reviews only.
import { cachedManyTagged, cachedTagged } from "@cnote/core";
import { prisma } from "@cnote/db";
import { SELLER_REVIEWS_TAG } from "./cache";
import { PAGE_SIZE } from "./constants";
import { authorNames } from "./read";
import type { Page, PublicReview } from "./types";

export interface SellerRatingSummary {
  sellerBusinessId: string;
  count: number;
  /** 0 when there are no ratings; otherwise one decimal place */
  average: number;
  /** counts for 1 to 5 stars (index 0 = 1 star) */
  histogram: [number, number, number, number, number];
}

export interface SellerReview extends PublicReview {
  listingId: string;
}

const empty = (sellerBusinessId: string): SellerRatingSummary => ({ sellerBusinessId, count: 0, average: 0, histogram: [0, 0, 0, 0, 0] });

/** Pure aggregation of grouped approved ratings (unit-tested). */
export function toSellerSummary(sellerBusinessId: string, groups: { rating: number; count: number }[]): SellerRatingSummary {
  const histogram: SellerRatingSummary["histogram"] = [0, 0, 0, 0, 0];
  let sum = 0;
  let count = 0;
  for (const g of groups) {
    if (g.rating < 1 || g.rating > 5) continue;
    histogram[g.rating - 1] = (histogram[g.rating - 1] ?? 0) + g.count;
    sum += g.rating * g.count;
    count += g.count;
  }
  return count === 0 ? empty(sellerBusinessId) : { sellerBusinessId, count, average: Math.round((sum / count) * 10) / 10, histogram };
}

/** One entry per requested seller (zero-count when unrated). Cached per seller; moderation purges the `reviews:sellers` tag. */
export async function getSellerRatingSummaries(sellerBusinessIds: string[]): Promise<Map<string, SellerRatingSummary>> {
  const ids = [...new Set(sellerBusinessIds)];
  if (!ids.length) return new Map();
  const found = await cachedManyTagged<SellerRatingSummary>(ids, {
    prefix: "reviews:seller-rating:v1",
    tags: () => [SELLER_REVIEWS_TAG],
    ttlSeconds: 300,
    staleSeconds: 900,
    load: async (missing) => {
      const groups = await prisma.productReview.groupBy({ by: ["sellerBusinessId", "rating"], where: { sellerBusinessId: { in: missing }, status: "approved" }, _count: { _all: true } });
      return new Map(
        missing.map((id) => [id, toSellerSummary(id, groups.filter((g) => g.sellerBusinessId === id).map((g) => ({ rating: g.rating, count: g._count._all })))]),
      );
    },
  });
  return new Map(ids.map((id) => [id, found.get(id) ?? empty(id)]));
}

/** Approved reviews across all of a seller's listings, newest first. Cursor is an offset (opaque to callers). */
export async function listApprovedSellerReviews(sellerBusinessId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<Page<SellerReview>> {
  const take = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 50);
  const n = Number(opts.cursor);
  const skip = Number.isInteger(n) && n > 0 ? n : 0;
  return cachedTagged(
    `reviews:seller-list:v1:${sellerBusinessId}:${skip}:${take}`,
    [SELLER_REVIEWS_TAG],
    60,
    async () => {
      const rows = await prisma.productReview.findMany({
        where: { sellerBusinessId, status: "approved" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: take + 1,
      });
      const page = rows.slice(0, take);
      const name = await authorNames(page);
      return {
        items: page.map((r) => ({
          id: r.id,
          listingId: r.listingId,
          rating: r.rating,
          title: r.title,
          body: r.body,
          authorName: name(r),
          verifiedEnquiry: r.verifiedEnquiry,
          helpfulCount: r.helpfulCount,
          createdAt: r.createdAt.toISOString(),
          sellerReply: r.sellerReply && r.sellerReplyStatus === "approved" ? { body: r.sellerReply, at: (r.sellerRepliedAt ?? r.updatedAt).toISOString() } : null,
        })),
        nextCursor: rows.length > take ? String(skip + take) : null,
      };
    },
    { staleSeconds: 300 },
  );
}
