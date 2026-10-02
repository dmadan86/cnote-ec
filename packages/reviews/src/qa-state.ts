import type { Prisma } from "@cnote/db";

/**
 * Keeps ProductQuestion.answeredAt equal to "this question is public": the question is approved AND its answer is
 * approved. Call inside the transaction of any status change to either row. Keeps the earliest answer time on a
 * re-approval so the public list doesn't reshuffle.
 */
export async function syncAnswered(tx: Prisma.TransactionClient, questionId: string): Promise<void> {
  const q = await tx.productQuestion.findUnique({ where: { id: questionId }, select: { status: true, answeredAt: true, answers: { select: { status: true, moderatedAt: true, updatedAt: true }, take: 1 } } });
  if (!q) return;
  const a = q.answers[0];
  const answered = q.status === "approved" && a?.status === "approved";
  const next = answered ? (q.answeredAt ?? a!.moderatedAt ?? a!.updatedAt) : null;
  if ((next === null) !== (q.answeredAt === null)) await tx.productQuestion.update({ where: { id: questionId }, data: { answeredAt: next } });
}
