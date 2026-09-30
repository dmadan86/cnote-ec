import { DomainError, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { REACTIONS_PER_HOUR, REPORT_THRESHOLD } from "./constants";
import { bustReviewCaches } from "./cache";
import { recomputeSummary } from "./summary";
import type { Actor } from "./types";
import { reportReason } from "./validate";

export type ReactionKind = "helpful" | "report";
export interface ReactInput {
  subjectType: "review" | "comment";
  subjectId: string;
  kind: ReactionKind;
  /** required for "report" */
  reason?: string;
}

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/**
 * "helpful" (reviews only, counted on approved reviews) and "report" (abuse). One of each per person
 * per item; repeats are no-ops (`changed: false`). An approved item reaching REPORT_THRESHOLD reports
 * goes back to "flagged" (hidden until staff re-approve) and leaves the rating aggregate.
 */
export async function react(actor: Actor, input: ReactInput): Promise<{ changed: boolean }> {
  const { subjectType, subjectId, kind } = input;
  if (kind === "helpful" && subjectType !== "review") throw new DomainError("validation", "Only reviews can be marked helpful.", undefined, "reviews.onlyReviewsMarkedHelpful");
  const reason = kind === "report" ? reportReason.parse(input.reason) : null;
  if (!(await rateLimit(`reviews:react:${actor.personId}`, REACTIONS_PER_HOUR, 3_600))) throw new DomainError("rate_limited", "Too many actions. Please slow down.");

  let touched: string | null = null;
  try {
    const res = await prisma.$transaction(async (tx) => {
      const subject =
        subjectType === "review"
          ? await tx.productReview.findUnique({ where: { id: subjectId }, select: { authorPersonId: true, status: true, listingId: true } })
          : await tx.productComment.findUnique({ where: { id: subjectId }, select: { authorPersonId: true, status: true, listingId: true } });
      if (!subject || subject.status !== "approved") throw new DomainError("not_found", "Nothing to react to here.", undefined, "reviews.nothingReactHere");
      touched = subject.listingId;
      if (subject.authorPersonId === actor.personId) throw new DomainError("forbidden", kind === "helpful" ? "You can't vote on your own review." : "You can't report your own post.");

      const dup = await tx.ugcReaction.findUnique({ where: { subjectType_subjectId_personId_kind: { subjectType, subjectId, personId: actor.personId, kind } } });
      if (dup) return { changed: false };
      await tx.ugcReaction.create({ data: { subjectType, subjectId, personId: actor.personId, kind, reason } });

      if (kind === "helpful") {
        await tx.productReview.update({ where: { id: subjectId }, data: { helpfulCount: { increment: 1 } } });
        return { changed: true };
      }
      const updated =
        subjectType === "review"
          ? await tx.productReview.update({ where: { id: subjectId }, data: { reportCount: { increment: 1 } }, select: { reportCount: true } })
          : await tx.productComment.update({ where: { id: subjectId }, data: { reportCount: { increment: 1 } }, select: { reportCount: true } });
      if (updated.reportCount >= REPORT_THRESHOLD) {
        const { count } =
          subjectType === "review"
            ? await tx.productReview.updateMany({ where: { id: subjectId, status: "approved" }, data: { status: "flagged" } })
            : await tx.productComment.updateMany({ where: { id: subjectId, status: "approved" }, data: { status: "flagged" } });
        if (count && subjectType === "review") await recomputeSummary(tx, subject.listingId);
      }
      return { changed: true };
    });
    if (res.changed && kind === "report" && touched) await bustReviewCaches(touched); // may have auto-flagged (hidden) the item
    return res;
  } catch (e) {
    if (isUniqueViolation(e)) return { changed: false }; // concurrent duplicate
    throw e;
  }
}
