"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { resolveGstReview } from "@cnote/identity";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

/** Manual GST verification decision (ADR-003). Requires businesses.verify; recorded in the audit log. */
export async function resolveGstReviewAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ id: fd.get("id"), businessId: fd.get("businessId"), decision: fd.get("decision"), note: fd.get("note") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "businesses.verify");
    await audited(
      ctx,
      "businesses.verify",
      "business.gst_review",
      { type: "business", id: input.businessId },
      () => resolveGstReview(input.id, input.decision, ctx.staff.id, input.note),
      { decision: input.decision, verificationRecordId: input.id, note: input.note ?? null },
    );
  });
  if (result.ok) {
    revalidatePath("/businesses");
    revalidatePath("/businesses/gst-reviews");
  }
  return result;
}
