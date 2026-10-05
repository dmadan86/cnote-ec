"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { labelEnquiry } from "@cnote/enquiry";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({ enquiryId: z.uuid(), label: z.enum(["genuine", "fake", "spam", "unreachable"]) });

/** Ops ground truth for fake-lead precision/recall (ADR-002). Audited under enquiries.review; emits EnquiryLabelled. */
export async function labelEnquiryAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ enquiryId: fd.get("enquiryId"), label: fd.get("label") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "enquiries.review");
    await audited(ctx, "enquiries.review", "enquiry.label", { type: "enquiry", id: input.enquiryId }, async () => { await labelEnquiry(input.enquiryId, input.label, ctx.staff.id); }, { label: input.label });
  });
  if (result.ok) revalidatePath("/fraud-labels");
  return result;
}
