import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { PAGE_SIZE } from "./constants";
import { recomputeSummary } from "./summary";
import type { ModerationItem, ModerationResult, ModerationSnapshot, Page, UgcKind, UgcStatus } from "./types";

export interface QueueFilters {
  kind: UgcKind;
  /** default: pending and flagged */
  status?: "pending" | "flagged";
  /** opaque; pass back nextCursor */
  cursor?: string | null;
  limit?: number;
}

const OPEN: UgcStatus[] = ["pending", "flagged"];

type ReviewRow = Prisma.ProductReviewGetPayload<object>;
type CommentRow = Prisma.ProductCommentGetPayload<{ include: { parent: { select: { body: true } } } }>;

const reviewItem = (r: ReviewRow): ModerationItem => ({
  kind: "review", id: r.id, listingId: r.listingId, sellerBusinessId: r.sellerBusinessId, status: r.status, rating: r.rating, title: r.title, body: r.body,
  context: null, isSeller: false, parentId: null, aiVerdict: r.aiVerdict, reportCount: r.reportCount, authorPersonId: r.authorPersonId,
  authorBusinessId: r.authorBusinessId, moderationNote: r.moderationNote, createdAt: r.createdAt.toISOString(),
});
/** A seller reply to a review lives on the review row; its author is the seller business (person not recorded). */
const replyItem = (r: ReviewRow): ModerationItem => ({
  kind: "reply", id: r.id, listingId: r.listingId, sellerBusinessId: r.sellerBusinessId, status: r.sellerReplyStatus ?? "pending", rating: r.rating, title: null,
  body: r.sellerReply ?? "", context: r.body, isSeller: true, parentId: null, aiVerdict: null, reportCount: 0, authorPersonId: "", authorBusinessId: r.sellerBusinessId,
  moderationNote: r.sellerReplyStatus === "rejected" ? r.moderationNote : null, createdAt: (r.sellerRepliedAt ?? r.updatedAt).toISOString(),
});
const commentItem = (r: CommentRow): ModerationItem => ({
  kind: "comment", id: r.id, listingId: r.listingId, sellerBusinessId: null, status: r.status, rating: null, title: null, body: r.body,
  context: r.parent?.body ?? null, isSeller: r.isSeller, parentId: r.parentId, aiVerdict: r.aiVerdict, reportCount: r.reportCount,
  authorPersonId: r.authorPersonId, authorBusinessId: r.authorBusinessId, moderationNote: r.moderationNote, createdAt: r.createdAt.toISOString(),
});

/**
 * Oldest first. kinds: "review" (product reviews), "comment" (questions and seller thread replies),
 * "reply" (a seller's reply to a review). Pending and flagged by default.
 */
export async function listModerationQueue(f: QueueFilters): Promise<Page<ModerationItem>> {
  const take = Math.min(Math.max(f.limit ?? PAGE_SIZE * 2, 1), 100);
  const statuses: UgcStatus[] = f.status ? [f.status] : OPEN;
  const cursor = f.cursor ? { id: f.cursor } : undefined;
  const paging = { take: take + 1, ...(cursor ? { cursor, skip: 1 } : {}) };
  let items: ModerationItem[];
  if (f.kind === "review") {
    items = (await prisma.productReview.findMany({ where: { status: { in: statuses } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], ...paging })).map(reviewItem);
  } else if (f.kind === "reply") {
    items = (await prisma.productReview.findMany({ where: { sellerReplyStatus: { in: statuses } }, orderBy: [{ sellerRepliedAt: "asc" }, { id: "asc" }], ...paging })).map(replyItem);
  } else {
    items = (await prisma.productComment.findMany({ where: { status: { in: statuses } }, include: { parent: { select: { body: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], ...paging })).map(commentItem);
  }
  const page = items.slice(0, take);
  return { items: page, nextCursor: items.length > take ? page[page.length - 1]!.id : null };
}

export async function getModerationItem(kind: UgcKind, id: string): Promise<ModerationItem | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (kind === "comment") {
    const r = await prisma.productComment.findUnique({ where: { id }, include: { parent: { select: { body: true } } } });
    return r ? commentItem(r) : null;
  }
  const r = await prisma.productReview.findUnique({ where: { id } });
  if (!r) return null;
  if (kind === "reply") return r.sellerReply ? replyItem(r) : null;
  return reviewItem(r);
}

const snap = (status: UgcStatus, moderationNote: string | null, reportCount: number): ModerationSnapshot => ({ status, moderationNote, reportCount });

/**
 * Staff decision. The caller (admin app) MUST wrap this in admin.audited(ctx, "ugc.moderate", ...) and
 * record `before`/`after`. Rejections require a note (shown to the author). Approving resets the
 * report count so a re-approved item isn't instantly re-flagged. Idempotent for a repeated decision.
 * Approve/reject changes the rating aggregate in the same transaction.
 */
export async function moderate(kind: UgcKind, id: string, decision: "approved" | "rejected", note: string | null, staffId: string): Promise<ModerationResult> {
  const cleanNote = note?.trim() || null;
  if (decision === "rejected" && !cleanNote) throw new DomainError("validation", "A note is required when rejecting, so the author knows why.");
  if (cleanNote && cleanNote.length > 500) throw new DomainError("validation", "Keep the note under 500 characters.");
  const now = new Date();

  return prisma.$transaction(async (tx): Promise<ModerationResult> => {
    if (kind === "comment") {
      const c = await tx.productComment.findUnique({ where: { id } });
      if (!c) throw new DomainError("not_found", "Comment not found.");
      const before = snap(c.status, c.moderationNote, c.reportCount);
      if (c.status === decision) return { kind, id, listingId: c.listingId, before, after: before };
      const u = await tx.productComment.update({
        where: { id },
        data: { status: decision, moderationNote: decision === "rejected" ? cleanNote : null, moderatedBy: staffId, moderatedAt: now, ...(decision === "approved" ? { reportCount: 0 } : {}) },
      });
      await emit(tx, "CommentModerated", { type: "comment", id }, { commentId: id, listingId: c.listingId, status: decision, moderatedBy: staffId });
      return { kind, id, listingId: c.listingId, before, after: snap(u.status, u.moderationNote, u.reportCount) };
    }

    const r = await tx.productReview.findUnique({ where: { id } });
    if (!r) throw new DomainError("not_found", "Review not found.");

    if (kind === "reply") {
      if (!r.sellerReply) throw new DomainError("not_found", "There is no reply to moderate.");
      const cur = r.sellerReplyStatus ?? "pending";
      // The schema has one note column per review; a rejected reply's note lives there until the review itself is moderated.
      const before = snap(cur, cur === "rejected" ? r.moderationNote : null, 0);
      if (cur === decision) return { kind, id, listingId: r.listingId, before, after: before };
      const u = await tx.productReview.update({
        where: { id },
        data: { sellerReplyStatus: decision, ...(decision === "rejected" ? { moderationNote: cleanNote } : {}) },
      });
      return { kind, id, listingId: r.listingId, before, after: snap(u.sellerReplyStatus ?? "pending", decision === "rejected" ? u.moderationNote : null, 0) };
    }

    const before = snap(r.status, r.moderationNote, r.reportCount);
    if (r.status === decision) return { kind, id, listingId: r.listingId, before, after: before };
    const u = await tx.productReview.update({
      where: { id },
      data: { status: decision, moderationNote: decision === "rejected" ? cleanNote : null, moderatedBy: staffId, moderatedAt: now, ...(decision === "approved" ? { reportCount: 0 } : {}) },
    });
    await recomputeSummary(tx, r.listingId);
    await emit(tx, "ReviewModerated", { type: "review", id }, {
      reviewId: id, listingId: r.listingId, sellerBusinessId: r.sellerBusinessId, status: decision, rating: r.rating, moderatedBy: staffId,
    });
    return { kind, id, listingId: r.listingId, before, after: snap(u.status, u.moderationNote, u.reportCount) };
  });
}
