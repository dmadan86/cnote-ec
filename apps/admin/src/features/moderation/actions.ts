"use server";
import { audited } from "@cnote/admin";
import { moderate } from "@cnote/reviews";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({
  kind: z.enum(["review", "comment", "reply"]),
  id: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500, "Keep the note under 500 characters.").optional(),
});

/**
 * Approve/reject one UGC item. The privilege is re-checked against a fresh staff lookup inside audited()
 * ("ugc.moderate"), and the before/after snapshot from the module is written to the audit row.
 */
export async function moderateAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ kind: fd.get("kind"), id: fd.get("id"), decision: fd.get("decision"), note: fd.get("note") || undefined });
    if (input.decision === "rejected" && !input.note) throw new z.ZodError([{ code: "custom", path: ["note"], message: "A note is required when rejecting.", input: input.note }]);
    const ctx = await actionContext();
    const details: Record<string, unknown> = { decision: input.decision, note: input.note ?? null };
    await audited(
      ctx,
      "ugc.moderate",
      `ugc.${input.kind}.${input.decision}`,
      { type: `ugc_${input.kind}`, id: input.id },
      async () => {
        const r = await moderate(input.kind, input.id, input.decision, input.note ?? null, ctx.staff.id);
        details.listingId = r.listingId;
        details.before = r.before;
        details.after = r.after;
      },
      details,
    );
  });
  if (result.ok) revalidatePath("/moderation");
  return result;
}
