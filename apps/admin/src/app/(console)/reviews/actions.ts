"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { listOpenReviews, resolveReview } from "@cnote/ai";
import { resolveListingModeration } from "@cnote/catalogue";
import { DomainError } from "@cnote/core";
import { resolveEnquiryReview } from "@cnote/enquiry";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({
  id: z.string().min(1).max(100),
  outcome: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
});

/** Approve/reject a review item, then apply the decision in the owning module. All inside audited(). */
export async function resolveReviewAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ id: fd.get("id"), outcome: fd.get("outcome"), reason: fd.get("reason") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "reviews.resolve");
    // Never trust subject info from the client: re-read the item from the open queue.
    const item = (await listOpenReviews(500)).find((r) => r.id === input.id);
    if (!item) throw new DomainError("not_found", "This item is no longer open (already resolved?).");
    // The owning module's privilege is required as well.
    if (item.subjectType === "listing") requirePrivilege(ctx.staff, "listings.moderate");
    if (item.subjectType === "enquiry") requirePrivilege(ctx.staff, "enquiries.review");
    await audited(
      ctx,
      "reviews.resolve",
      "review.resolve",
      { type: "review_item", id: item.id },
      async () => {
        // Owning module first: if it fails the item stays open and can be retried.
        if (item.subjectType === "listing") await resolveListingModeration(item.subjectId, input.outcome, input.reason);
        else if (item.subjectType === "enquiry") await resolveEnquiryReview(item.subjectId, input.outcome);
        await resolveReview(item.id, input.outcome, ctx.staff.personId);
      },
      { outcome: input.outcome, capability: item.capability, subjectType: item.subjectType, subjectId: item.subjectId, reason: input.reason ?? null },
    );
  });
  if (!result.ok) return result;
  revalidatePath("/reviews");
  revalidatePath("/");
  redirect("/reviews");
}
