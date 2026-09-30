"use server";
import { audited } from "@cnote/admin";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { resolveAlert } from "@cnote/metrics";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({ id: z.string().uuid() });

/** Mark a metric alert resolved. Needs metrics.read (no dedicated write privilege in v1); audited as metric_alert.resolve. */
export async function resolveAlertAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ id: fd.get("id") });
    const ctx = await actionContext();
    await audited(ctx, "metrics.read", "metric_alert.resolve", { type: "metric_alert", id: input.id }, () => resolveAlert(input.id, ctx.staff.id));
  });
  if (result.ok) {
    revalidatePath("/metrics");
    revalidatePath("/metrics/[metric]", "page");
  }
  return result;
}
