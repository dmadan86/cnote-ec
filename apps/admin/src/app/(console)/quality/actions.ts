"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { labelResult, setCategoryEnabled } from "@cnote/quality";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const labelSchema = z.object({ resultId: z.uuid(), label: z.enum(["consistent", "inconsistent", "inconclusive"]) });

/** Records the staff ground-truth label for one advisory result (ADR-015 golden set). */
export async function labelResultAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = labelSchema.parse({ resultId: fd.get("resultId"), label: fd.get("label") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "quality.review");
    await audited(ctx, "quality.review", "quality.label", { type: "quality_result", id: input.resultId }, () => labelResult(ctx.staff.personId, input.resultId, input.label), { label: input.label });
  });
  if (result.ok) revalidatePath("/quality");
  return result;
}

const toggleSchema = z.object({ categorySlug: z.string().trim().min(1).max(80), enabled: z.enum(["true", "false"]) });

/** Enable/disable a category. Enabling is gated inside setCategoryEnabled (accuracy > 90% with >= N labels); audited either way. */
export async function toggleCategoryAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = toggleSchema.parse({ categorySlug: fd.get("categorySlug"), enabled: fd.get("enabled") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "quality.review");
    const enabled = input.enabled === "true";
    await audited(ctx, "quality.review", enabled ? "quality.category.enable" : "quality.category.disable", { type: "quality_category", id: input.categorySlug }, async () => {
      await setCategoryEnabled(input.categorySlug, enabled, ctx.staff.personId);
    }, { enabled });
  });
  if (result.ok) revalidatePath("/quality");
  return result;
}
