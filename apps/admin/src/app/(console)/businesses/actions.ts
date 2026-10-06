"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { releaseGstinClaim, resolveGstReview, resolveRegistryReview } from "@cnote/identity";
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

const releaseSchema = z.object({ businessId: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500) });

/** "Dispute this GSTIN": staff release a business's claim on its GSTIN (e.g. a squatter reported by the real owner). Audited. */
export async function releaseGstinClaimAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = releaseSchema.parse({ businessId: fd.get("businessId"), reason: fd.get("reason") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "businesses.verify");
    await audited(
      ctx,
      "businesses.verify",
      "business.gstin_release",
      { type: "business", id: input.businessId },
      () => releaseGstinClaim(input.businessId, ctx.staff.id, input.reason),
      { reason: input.reason },
    );
  });
  if (result.ok) {
    revalidatePath("/businesses");
    revalidatePath(`/businesses/${fd.get("businessId")}`);
  }
  return result;
}

/** Manual Udyam / MCA verification decision (ADR-003 T1). Requires businesses.verify; recorded in the audit log. */
export async function resolveRegistryReviewAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ id: fd.get("id"), businessId: fd.get("businessId"), decision: fd.get("decision"), note: fd.get("note") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "businesses.verify");
    await audited(
      ctx, "businesses.verify", "business.registry_review", { type: "business", id: input.businessId },
      () => resolveRegistryReview(input.id, input.decision, ctx.staff.id, input.note),
      { decision: input.decision, verificationRecordId: input.id, note: input.note ?? null },
    );
  });
  if (result.ok) revalidatePath("/businesses/registry-reviews");
  return result;
}
