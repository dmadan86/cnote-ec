// DPDP access right (ADR-010): reviews, comments, reactions and Q&A the person wrote. Registered with @cnote/compliance's export registry.
import { EXPORT_TAKE, exportCollection, type PersonalExport } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string): Promise<PersonalExport> {
  const q = { orderBy: { createdAt: "asc" as const }, take: EXPORT_TAKE };
  const [reviews, comments, questions, answers, reactions] = await Promise.all([
    prisma.productReview.findMany({
      where: { authorPersonId: personId }, ...q,
      select: { id: true, listingId: true, rating: true, title: true, body: true, language: true, verifiedEnquiry: true, status: true, moderationNote: true, sellerReply: true, createdAt: true },
    }),
    prisma.productComment.findMany({ where: { authorPersonId: personId }, ...q, select: { id: true, listingId: true, parentId: true, body: true, language: true, status: true, moderationNote: true, createdAt: true } }),
    prisma.productQuestion.findMany({ where: { authorPersonId: personId }, ...q, select: { id: true, listingId: true, body: true, language: true, status: true, moderationNote: true, answeredAt: true, createdAt: true } }),
    prisma.productAnswer.findMany({ where: { authorPersonId: personId }, ...q, select: { id: true, questionId: true, listingId: true, body: true, language: true, status: true, createdAt: true } }),
    prisma.ugcReaction.findMany({ where: { personId }, ...q, select: { subjectType: true, subjectId: true, kind: true, reason: true, createdAt: true } }),
  ]);
  return {
    reviews: exportCollection(reviews), comments: exportCollection(comments), questions: exportCollection(questions),
    answers: exportCollection(answers), reactions: exportCollection(reactions),
  };
}
