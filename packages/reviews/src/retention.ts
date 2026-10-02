// Retention (ADR-010, DPDP storage limitation). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

/**
 * Deletes REJECTED reviews, comments, questions and answers moderated before `before` (rejected content never counted toward ratings
 * and was never public). Comments that still have replies are skipped until their replies go (idempotent over
 * repeated runs). `dryRun` only counts. Returns rows deleted.
 */
export async function purgeRejectedUgc(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const reviewWhere = { status: "rejected" as const, moderatedAt: { lt: before } };
  const commentWhere = { status: "rejected" as const, moderatedAt: { lt: before }, replies: { none: {} } };
  const qWhere = { status: "rejected" as const, moderatedAt: { lt: before }, answers: { none: {} } };
  const aWhere = { status: "rejected" as const, moderatedAt: { lt: before } };
  if (opts.dryRun) {
    return (await prisma.productReview.count({ where: reviewWhere })) + (await prisma.productComment.count({ where: commentWhere }))
      + (await prisma.productQuestion.count({ where: qWhere })) + (await prisma.productAnswer.count({ where: aWhere }));
  }
  const reviews = await prisma.productReview.findMany({ where: reviewWhere, select: { id: true } });
  const comments = await prisma.productComment.findMany({ where: commentWhere, select: { id: true } });
  // answers first: a rejected question that still has answers is purged on a later run, once they are gone
  const answers = await prisma.productAnswer.findMany({ where: aWhere, select: { id: true } });
  await prisma.productAnswer.deleteMany({ where: { id: { in: answers.map((a) => a.id) } } });
  const questions = await prisma.productQuestion.findMany({ where: qWhere, select: { id: true } });
  const ids = [...reviews.map((r) => r.id), ...comments.map((c) => c.id), ...questions.map((q) => q.id), ...answers.map((a) => a.id)];
  await prisma.$transaction([
    prisma.ugcReaction.deleteMany({ where: { subjectId: { in: ids } } }),
    prisma.productReview.deleteMany({ where: { id: { in: reviews.map((r) => r.id) } } }),
    prisma.productComment.deleteMany({ where: { id: { in: comments.map((c) => c.id) } } }),
    prisma.productQuestion.deleteMany({ where: { id: { in: questions.map((q) => q.id) } } }),
  ]);
  return ids.length;
}
