// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

/**
 * Deletes REJECTED reviews and comments moderated before `before` (rejected content never counted toward ratings
 * and was never public). Comments that still have replies are skipped until their replies go (idempotent over
 * repeated runs). `dryRun` only counts. Returns rows deleted (reviews + comments).
 */
export async function purgeRejectedUgc(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const reviewWhere = { status: "rejected" as const, moderatedAt: { lt: before } };
  const commentWhere = { status: "rejected" as const, moderatedAt: { lt: before }, replies: { none: {} } };
  if (opts.dryRun) return (await prisma.productReview.count({ where: reviewWhere })) + (await prisma.productComment.count({ where: commentWhere }));
  const reviews = await prisma.productReview.findMany({ where: reviewWhere, select: { id: true } });
  const comments = await prisma.productComment.findMany({ where: commentWhere, select: { id: true } });
  const ids = [...reviews.map((r) => r.id), ...comments.map((c) => c.id)];
  await prisma.$transaction([
    prisma.ugcReaction.deleteMany({ where: { subjectId: { in: ids } } }),
    prisma.productReview.deleteMany({ where: { id: { in: reviews.map((r) => r.id) } } }),
    prisma.productComment.deleteMany({ where: { id: { in: comments.map((c) => c.id) } } }),
  ]);
  return ids.length;
}
