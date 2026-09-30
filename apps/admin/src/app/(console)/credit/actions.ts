"use server";
import { audited } from "@cnote/admin";
import { computeAndStoreScore, expireOffers, updateDpd } from "@cnote/credit";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const rescore = z.object({ businessId: z.uuid(), reason: z.string().trim().min(3, "Give a reason (min 3 characters)").max(300) });

/** Recompute a business's score now (consent still required; a no-op result says so). credit.manage, audited. */
export async function rescoreAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = rescore.parse({ businessId: fd.get("businessId"), reason: fd.get("reason") });
    const ctx = await actionContext();
    const s = await audited(ctx, "credit.manage", "credit.rescore", { type: "business", id: input.businessId }, () => computeAndStoreScore(input.businessId, "staff"), { reason: input.reason });
    if (!s) throw new Error("This business has not given credit_underwriting consent, so no score was computed.");
  });
  if (result.ok) revalidatePath("/credit");
  return result;
}

/** Refresh days-past-due for every open loan and expire stale offers now. credit.manage, audited. */
export async function refreshBookAction(..._args: [ActionResult | null, FormData?]): Promise<ActionResult> {
  void _args;
  const result = await runAction(async () => {
    const ctx = await actionContext();
    await audited(ctx, "credit.manage", "credit.refresh_book", { type: "credit", id: "book" }, async () => ({ dpd: await updateDpd(), offers: await expireOffers() }), {});
  });
  if (result.ok) revalidatePath("/credit");
  return result;
}
