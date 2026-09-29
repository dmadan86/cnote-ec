import { listSellerListings } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";
import { prisma, type Prisma } from "@cnote/db";
import { PAGE_SIZE, isTombstone } from "./constants";
import { authorStatus } from "./screen";
import { toMyReview } from "./submit";
import type { MyComment, MyReview, Page, PublicComment, PublicReview, ReviewSort, SellerUgcItem, UgcStatus } from "./types";

/** Business name when the author has one (never the person's own name or contact details). */
export async function authorNames(rows: { authorPersonId: string; authorBusinessId: string | null; isSeller?: boolean }[]): Promise<(r: { authorPersonId: string; authorBusinessId: string | null; isSeller?: boolean }) => string> {
  const ids = rows.filter((r) => r.authorBusinessId && !isTombstone(r.authorPersonId)).map((r) => r.authorBusinessId!);
  let profiles = new Map<string, { name: string }>();
  try {
    profiles = await getTrustProfiles(ids);
  } catch (err) {
    console.error("[reviews] identity lookup failed", err instanceof Error ? err.message : err);
  }
  return (r) => {
    if (isTombstone(r.authorPersonId)) return "Former user";
    const name = r.authorBusinessId ? profiles.get(r.authorBusinessId)?.name : undefined;
    return name ?? (r.isSeller ? "Seller" : "Buyer");
  };
}

const offsetOf = (cursor?: string | null) => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const REVIEW_ORDER: Record<ReviewSort, Prisma.ProductReviewOrderByWithRelationInput[]> = {
  recent: [{ createdAt: "desc" }, { id: "desc" }],
  helpful: [{ helpfulCount: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  rating_high: [{ rating: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  rating_low: [{ rating: "asc" }, { createdAt: "desc" }, { id: "desc" }],
};

/** Approved reviews only. Cursor is an offset (opaque to callers). */
export async function listApprovedReviews(
  listingId: string,
  opts: { sort?: ReviewSort; cursor?: string | null; limit?: number } = {},
): Promise<Page<PublicReview>> {
  const take = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 50);
  const skip = offsetOf(opts.cursor);
  const rows = await prisma.productReview.findMany({
    where: { listingId, status: "approved" },
    orderBy: REVIEW_ORDER[opts.sort ?? "recent"],
    skip,
    take: take + 1,
  });
  const page = rows.slice(0, take);
  const name = await authorNames(page);
  return {
    items: page.map((r) => ({
      id: r.id,
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
}

/** Approved top-level comments (oldest first) with their approved replies. */
export async function listApprovedComments(listingId: string, opts: { limit?: number } = {}): Promise<PublicComment[]> {
  const rows = await prisma.productComment.findMany({
    where: { listingId, status: "approved", parentId: null },
    include: { replies: { where: { status: "approved" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(opts.limit ?? 50, 1), 100),
  });
  const name = await authorNames(rows.flatMap((r) => [r, ...r.replies]));
  const view = (r: (typeof rows)[number] | (typeof rows)[number]["replies"][number]) => ({
    id: r.id, body: r.body, authorName: name(r), isSeller: r.isSeller, createdAt: r.createdAt.toISOString(),
  });
  return rows.map((r) => ({ ...view(r), replies: r.replies.map(view) }));
}

export async function getMyReview(listingId: string, personId: string): Promise<MyReview | null> {
  const r = await prisma.productReview.findUnique({ where: { listingId_authorPersonId: { listingId, authorPersonId: personId } } });
  return r ? toMyReview(r) : null;
}

/** The person's own comments on a listing that are not public yet (pending/flagged) or were rejected. */
export async function listMyPendingComments(listingId: string, personId: string): Promise<MyComment[]> {
  const rows = await prisma.productComment.findMany({
    where: { listingId, authorPersonId: personId, status: { in: ["pending", "flagged", "rejected"] } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((r) => ({
    id: r.id, parentId: r.parentId, body: r.body, status: authorStatus(r.status),
    moderationNote: r.status === "rejected" ? r.moderationNote : null, createdAt: r.createdAt.toISOString(),
  }));
}

export interface SellerUgcFilters {
  kind?: "review" | "comment";
  listingId?: string;
  /** only items the seller has not answered yet (no reply, or the reply was rejected) */
  needsReply?: boolean;
  cursor?: string | null;
  limit?: number;
}

/**
 * What a seller sees on their listings: approved reviews (with their reply + its moderation state)
 * and approved questions (with the seller's own thread replies in any state). Content still under
 * moderation is not shown to the seller.
 */
export async function listSellerUgc(sellerBusinessId: string, filters: SellerUgcFilters = {}): Promise<Page<SellerUgcItem>> {
  const take = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  const skip = offsetOf(filters.cursor);
  const kind = filters.kind ?? "review";

  if (kind === "review") {
    const rows = await prisma.productReview.findMany({
      where: {
        sellerBusinessId, status: "approved", listingId: filters.listingId,
        ...(filters.needsReply ? { OR: [{ sellerReply: null }, { sellerReplyStatus: "rejected" }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: take + 1,
    });
    const page = rows.slice(0, take);
    const name = await authorNames(page);
    return {
      items: page.map((r) => ({
        kind: "review" as const, id: r.id, listingId: r.listingId, status: r.status as UgcStatus, rating: r.rating, title: r.title, body: r.body,
        authorName: name(r), createdAt: r.createdAt.toISOString(),
        reply: r.sellerReply ? { id: r.id, body: r.sellerReply, status: (r.sellerReplyStatus ?? "pending") as UgcStatus, moderationNote: r.sellerReplyStatus === "rejected" ? r.moderationNote : null } : null,
        needsReply: !r.sellerReply || r.sellerReplyStatus === "rejected",
      })),
      nextCursor: rows.length > take ? String(skip + take) : null,
    };
  }

  // Comments carry no seller id: scope through the seller's listings (catalogue owns that relation).
  const mine = (await listSellerListings(sellerBusinessId)).map((l) => l.id);
  const listingIds = filters.listingId ? mine.filter((id) => id === filters.listingId) : mine;
  const rows = await prisma.productComment.findMany({
    where: { listingId: { in: listingIds }, parentId: null, status: "approved" },
    include: { replies: { where: { isSeller: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  // needsReply is derived from the latest seller reply, so filter before paginating.
  const all = filters.needsReply ? rows.filter((r) => !r.replies[0] || r.replies[0].status === "rejected") : rows;
  const page = all.slice(skip, skip + take);
  const name = await authorNames(page);
  return {
    items: page.map((r) => {
      const reply = r.replies[0];
      return {
        kind: "comment" as const, id: r.id, listingId: r.listingId, status: r.status as UgcStatus, rating: null, title: null, body: r.body,
        authorName: name(r), createdAt: r.createdAt.toISOString(),
        reply: reply ? { id: reply.id, body: reply.body, status: reply.status as UgcStatus, moderationNote: reply.status === "rejected" ? reply.moderationNote : null } : null,
        needsReply: !reply || reply.status === "rejected",
      };
    }),
    nextCursor: all.length > skip + take ? String(skip + take) : null,
  };
}
