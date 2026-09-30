"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { replayInboundDeadLetter, resetContact } from "@cnote/whatsapp";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

/** Send a conversation back to the start (identity links kept). Needs businesses.verify; audited. */
export async function resetConversationAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const { id } = z.object({ id: z.uuid() }).parse({ id: fd.get("id") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "businesses.verify");
    await audited(ctx, "businesses.verify", "whatsapp.reset_conversation", { type: "whatsapp_contact", id }, () => resetContact(id));
  });
  if (result.ok) revalidatePath("/whatsapp");
  return result;
}

/** Retry a failed inbound job (the reply that never went out is re-generated from the seller's last message). */
export async function retryInboundAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse({ id: fd.get("id") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "businesses.verify");
    const ok = await audited(ctx, "businesses.verify", "whatsapp.retry_inbound", { type: "queue_job", id }, () => replayInboundDeadLetter(id));
    if (!ok) throw new DomainError("not_found", "That job is no longer in the dead-letter queue.");
  });
  if (result.ok) revalidatePath("/whatsapp");
  return result;
}
