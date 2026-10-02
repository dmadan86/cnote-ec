"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { resolveRefundReview } from "@cnote/enquiry";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({ id: z.string().uuid(), decision: z.enum(["approved", "rejected"]) });

/** Security audit M2: decide a lead-refund request that tripped the refund guard. Approve = refund; reject = lead stays accepted. */
export async function decideRefundReviewAction(fd: FormData): Promise<void> {
  const input = schema.parse({ id: fd.get("id"), decision: fd.get("decision") });
  const ctx = await actionContext();
  requirePrivilege(ctx.staff, "enquiries.review");
  await audited(
    ctx,
    "enquiries.review",
    "lead_refund.resolve",
    { type: "lead_refund_review", id: input.id },
    () => resolveRefundReview(input.id, input.decision, ctx.staff.personId),
    { decision: input.decision },
  );
  revalidatePath("/lead-refunds");
}
