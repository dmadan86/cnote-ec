// Public lookups for other modules (notifications on moderation outcomes).
import { prisma } from "@cnote/db";

export interface ContentAuthor {
  authorPersonId: string;
  moderationNote: string | null;
}

const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function getReviewAuthor(reviewId: string): Promise<ContentAuthor | null> {
  if (!isId(reviewId)) return null;
  return prisma.productReview.findUnique({ where: { id: reviewId }, select: { authorPersonId: true, moderationNote: true } });
}

export async function getCommentAuthor(commentId: string): Promise<ContentAuthor | null> {
  if (!isId(commentId)) return null;
  return prisma.productComment.findUnique({ where: { id: commentId }, select: { authorPersonId: true, moderationNote: true } });
}
