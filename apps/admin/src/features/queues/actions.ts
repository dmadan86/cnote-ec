"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { listQueueTopics, replayDeadLetter } from "@cnote/notifications";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({ topic: z.string().min(1).max(100), id: z.string().min(1).max(200) });

/** Re-enqueue one dead-lettered job. Needs queues.replay; audited (topic + message id, never the payload). */
export async function replayDeadLetterAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ topic: fd.get("topic"), id: fd.get("id") });
    // Only topics the console lists can be replayed from here.
    if (!listQueueTopics().some((t) => t.topic === input.topic)) throw new DomainError("validation", "Unknown queue topic.");
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "queues.replay");
    const ok = await audited(ctx, "queues.replay", "queue.replay", { type: "queue_job", id: input.id }, () => replayDeadLetter(input.topic, input.id), { topic: input.topic });
    if (!ok) throw new DomainError("not_found", "That job is no longer in the dead-letter queue.");
  });
  if (result.ok) revalidatePath("/queues");
  return result;
}
