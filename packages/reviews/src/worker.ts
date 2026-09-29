import type { ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { createHash } from "node:crypto";
import { bustAllReviewCaches } from "./cache";
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
  });
}

export const worker: ModuleWorker = {
  name: "reviews",
  handlers: {
    DataErasureRequested: async (event) => {
      await anonymisePerson(event.payload.personId);
      await bustAllReviewCaches();
    },
    // Listing pages 404 once archived, so nothing to hide; kept explicit to document the decision.
    ListingArchived: async () => {},
  },
  jobs: [],
};
