"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { replayCallback } from "@/lib/ondc";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

/** Re-queue a failed ONDC callback (ondc.manage; audited). */
export async function replayCallbackAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const { id } = z.object({ id: z.uuid() }).parse({ id: fd.get("id") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "ondc.manage");
    const ok = await audited(ctx, "ondc.manage", "ondc.replay_callback", { type: "ondc_message", id }, () => replayCallback(id));
    if (!ok) throw new DomainError("conflict", "That callback is no longer in a failed state.");
  });
  if (result.ok) revalidatePath("/ondc");
  return result;
}
