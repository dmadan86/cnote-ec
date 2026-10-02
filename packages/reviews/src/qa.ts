import { getListing } from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { ANSWERS_PER_HOUR, OPEN_QUESTIONS_PER_LISTING, QUESTIONS_PER_DAY, QUESTIONS_PER_HOUR } from "./constants";
import { bustQaCaches } from "./cache";
import { authorStatus, screenQa } from "./screen";
import { answerInput, meaningfulLength, questionInput, stripContact, type AnswerInput, type QuestionInput } from "./qa-validate";
import type { Actor, MyQuestion, UgcStatus } from "./types";

async function limit(key: string, max: number, windowSeconds: number, msg: string) {
  if (!(await rateLimit(key, max, windowSeconds))) throw new DomainError("rate_limited", msg);
}

const isSellerSide = (actor: Actor, sellerBusinessId: string) => actor.businessId !== null && actor.businessId === sellerBusinessId;

export const toMyQuestion = (
  q: { id: string; body: string; status: UgcStatus; moderationNote: string | null; piiStripped: boolean; createdAt: Date; answeredAt: Date | null },
  answer: { body: string } | null,
): MyQuestion => ({
  id: q.id, body: q.body, status: authorStatus(q.status), moderationNote: q.status === "rejected" ? q.moderationNote : null, piiStripped: q.piiStripped,
  createdAt: q.createdAt.toISOString(),
  answer: answer && q.answeredAt ? { body: answer.body, answeredAt: q.answeredAt.toISOString() } : null,
});

/**
 * Ask a question about a published product (signed-in users; not the seller's own team).
 *  - contact details are STRIPPED before anything is stored or screened (ADR-002/010);
 *  - the cleaned text goes through ai.moderate with the listing's category (prohibited-category check): allow → approved
 *    (visible to the asker and the seller only), anything else → flagged for staff, model down → pending (staff-gated);
 *  - public only once the seller's answer is approved (see listPublicQuestions).
 * Rate limited per person (hourly + daily) and capped on unanswered questions per listing. Callers add a per-IP limit.
 */
export async function askQuestion(actor: Actor, listingId: string, rawInput: QuestionInput): Promise<MyQuestion> {
  const input = questionInput.parse(rawInput);
  const listing = await getListing(listingId);
  if (!listing || listing.status !== "published") throw new DomainError("not_found", "This product is not available.");
  if (isSellerSide(actor, listing.sellerBusinessId)) throw new DomainError("forbidden", "You can't ask a question about your own product.", undefined, "qa.ownProduct");

  const { text, stripped } = stripContact(input.body);
  if (meaningfulLength(text) < 5) throw new DomainError("validation", "Your message was mostly contact details, which we remove. Please ask about the product itself.", undefined, "qa.onlyContact");

  await limit(`qa:ask:h:${actor.personId}`, QUESTIONS_PER_HOUR, 3_600, "You're asking too quickly. Please wait a little and try again.");
  await limit(`qa:ask:d:${actor.personId}`, QUESTIONS_PER_DAY, 86_400, "You've reached today's question limit. Please try again tomorrow.");

  const open = await prisma.productQuestion.count({
    where: { listingId, authorPersonId: actor.personId, status: { in: ["pending", "flagged", "approved"] }, answeredAt: null },
  });
  if (open >= OPEN_QUESTIONS_PER_LISTING) {
    throw new DomainError("conflict", "You already have questions waiting for an answer on this product. Please wait for the seller to reply.", undefined, "qa.tooManyOpen");
  }
  const dup = await prisma.productQuestion.findFirst({ where: { listingId, authorPersonId: actor.personId, body: text, status: { not: "rejected" } }, select: { id: true } });
  if (dup) throw new DomainError("conflict", "You've already asked this question.", undefined, "qa.duplicate");

  const id = randomUUID();
  const screen = await screenQa(text, id, listing.category.slug);
  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.productQuestion.create({
      data: {
        id, listingId, sellerBusinessId: listing.sellerBusinessId, authorPersonId: actor.personId, authorBusinessId: actor.businessId,
        body: text, language: input.language, piiStripped: stripped, status: screen.status, aiVerdict: screen.aiVerdict, aiDecisionId: screen.aiDecisionId,
      },
    });
    await emit(tx, "ProductQuestionAsked", { type: "product_question", id }, {
      questionId: id, listingId, sellerBusinessId: listing.sellerBusinessId, askerPersonId: actor.personId, status: screen.status, aiVerdict: screen.aiVerdict, piiStripped: stripped,
    });
    return saved;
  });
  return toMyQuestion(row, null);
}

export interface AnswerResult {
  id: string;
  questionId: string;
  status: "pending" | "approved";
  piiStripped: boolean;
}

/**
 * The seller answers (or edits their answer to) a question on their product. One answer per question; every write is
 * stripped of contact details and screened again, and only an approved answer makes the question public. A flagged
 * answer waits for staff; the seller sees it as "awaiting approval".
 */
export async function answerQuestion(actor: Actor, questionId: string, rawInput: AnswerInput): Promise<AnswerResult> {
  const input = answerInput.parse(rawInput);
  const q = await prisma.productQuestion.findUnique({ where: { id: questionId } });
  if (!q || q.status !== "approved") throw new DomainError("not_found", "That question isn't available.", undefined, "qa.questionGone");
  if (!isSellerSide(actor, q.sellerBusinessId)) throw new DomainError("forbidden", "Only the seller can answer this question.", undefined, "qa.sellerOnly");

  const { text, stripped } = stripContact(input.body);
  if (meaningfulLength(text) < 2) throw new DomainError("validation", "Your message was mostly contact details, which we remove. Please ask about the product itself.", undefined, "qa.onlyContact");
  await limit(`qa:answer:${actor.personId}`, ANSWERS_PER_HOUR, 3_600, "You're answering too quickly. Please wait a little and try again.");

  const listing = await getListing(q.listingId).catch(() => null);
  const answerId = randomUUID();
  const screen = await screenQa(text, answerId, listing?.category.slug);
  const approved = screen.status === "approved";

  const saved = await prisma.$transaction(async (tx) => {
    const existing = await tx.productAnswer.findUnique({ where: { questionId } });
    const data = {
      body: text, language: input.language, piiStripped: stripped, status: screen.status, aiVerdict: screen.aiVerdict, aiDecisionId: screen.aiDecisionId,
      moderationNote: null, moderatedBy: null, moderatedAt: null, authorPersonId: actor.personId, reportCount: 0,
    };
    const answer = existing
      ? await tx.productAnswer.update({ where: { id: existing.id }, data })
      : await tx.productAnswer.create({ data: { id: answerId, questionId, listingId: q.listingId, sellerBusinessId: q.sellerBusinessId, ...data } });
    await tx.productQuestion.update({ where: { id: questionId }, data: { answeredAt: approved ? new Date() : null } });
    await emit(tx, "ProductQuestionAnswered", { type: "product_question", id: questionId }, {
      questionId, answerId: answer.id, listingId: q.listingId, sellerBusinessId: q.sellerBusinessId, askerPersonId: q.authorPersonId,
      answeredByPersonId: actor.personId, status: screen.status, aiVerdict: screen.aiVerdict, piiStripped: stripped,
    });
    return answer;
  });
  await bustQaCaches(q.listingId); // an edited answer leaves the public list until it is approved again
  return { id: saved.id, questionId, status: approved ? "approved" : "pending", piiStripped: stripped };
}
