import type { ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getEnquirySummary } from "@cnote/enquiry";
import { hasVerifiedEnquiry } from "./verified";
import { createHash } from "node:crypto";
import { bustAllQaCaches, bustAllReviewCaches } from "./cache";
import { TOMBSTONE_PERSON_ID } from "./constants";

/**
 * Deterministic per-review tombstone id. Reviews are unique on (listingId, authorPersonId), so two
 * erased people who reviewed the same listing can't share one fixed id; the shared prefix keeps
 * isTombstone() true for both.
 */
const tombstoneForReview = (reviewId: string) => `${TOMBSTONE_PERSON_ID.slice(0, 24)}${createHash("sha256").update(reviewId).digest("hex").slice(0, 12)}`;

/**
 * DPDP erasure (ADR-010). Approved content stays public but loses its author link (person and
 * business ids replaced by tombstones; readers show "Former user"). Content that was never public
 * (pending/flagged/rejected) is deleted, as are the person's reactions. Idempotent: a re-run finds
 * nothing left under the person id.
 */
export async function anonymisePerson(personId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.ugcReaction.deleteMany({ where: { personId } });
    await tx.productReview.deleteMany({ where: { authorPersonId: personId, status: { not: "approved" } } });
    const reviews = await tx.productReview.findMany({ where: { authorPersonId: personId }, select: { id: true } });
    for (const r of reviews) {
      await tx.productReview.update({ where: { id: r.id }, data: { authorPersonId: tombstoneForReview(r.id), authorBusinessId: null } });
    }
    // Unpublished comments with replies must stay (FK); they're anonymised below like approved ones.
    await tx.productComment.deleteMany({ where: { authorPersonId: personId, status: { not: "approved" }, replies: { none: {} } } });
    await tx.productComment.updateMany({ where: { authorPersonId: personId }, data: { authorPersonId: TOMBSTONE_PERSON_ID, authorBusinessId: null } });
    // Questions: never-public ones (not approved, or approved but unanswered) go with their unpublished answers; public Q&A is anonymised.
    const dropQuestions = await tx.productQuestion.findMany({ where: { authorPersonId: personId, OR: [{ status: { not: "approved" } }, { answeredAt: null }] }, select: { id: true } });
    if (dropQuestions.length) {
      const ids = dropQuestions.map((q) => q.id);
      await tx.productAnswer.deleteMany({ where: { questionId: { in: ids } } });
      await tx.productQuestion.deleteMany({ where: { id: { in: ids } } });
    }
    await tx.productQuestion.updateMany({ where: { authorPersonId: personId }, data: { authorPersonId: TOMBSTONE_PERSON_ID, authorBusinessId: null } });
    await tx.productAnswer.updateMany({ where: { authorPersonId: personId }, data: { authorPersonId: TOMBSTONE_PERSON_ID } });
  });
}

export const worker: ModuleWorker = {
  name: "reviews",
  handlers: {
    DataErasureRequested: async (event) => {
      await anonymisePerson(event.payload.personId);
      await bustAllReviewCaches();
      await bustAllQaCaches();
    },
    // Security audit M2: a refunded lead no longer backs the "verified enquiry" badge. Recomputed from the enquiry module's
    // public getter; the badge stays when the buyer still has another accepted lead with the same seller.
    LeadRefunded: async (event) => {
      const enq = await getEnquirySummary(event.payload.enquiryId);
      if (!enq) return;
      if (await hasVerifiedEnquiry(enq.buyerBusinessId, event.payload.sellerBusinessId)) return;
      const r = await prisma.productReview.updateMany({
        where: { authorBusinessId: enq.buyerBusinessId, sellerBusinessId: event.payload.sellerBusinessId, verifiedEnquiry: true },
        data: { verifiedEnquiry: false },
      });
      if (r.count > 0) await bustAllReviewCaches();
    },
    // Listing pages 404 once archived, so nothing to hide; kept explicit to document the decision.
    ListingArchived: async () => {},
  },
  jobs: [],
};
