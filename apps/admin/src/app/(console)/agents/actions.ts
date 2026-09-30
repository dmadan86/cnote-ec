"use server";
import { liftSuspension, suspend } from "@cnote/a2a";
import { audited, requirePrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const reason = z.string().trim().min(5, "Give a reason (5+ characters).").max(500);
const suspendSchema = z.object({ kind: z.enum(["mandate", "business", "api_key"]), targetId: z.string().trim().min(1).max(200), reason });

/** Suspend a mandate, a business's agents or one API key (agents.suspend; audited, reason required). ADR-020. */
export async function suspendAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const p = suspendSchema.parse({ kind: fd.get("kind"), targetId: fd.get("targetId"), reason: fd.get("reason") });
    if (p.kind !== "api_key" && !z.uuid().safeParse(p.targetId).success) throw new DomainError("validation", "Enter a valid id (UUID).");
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "agents.suspend");
    await audited(ctx, "agents.suspend", `agents.suspend.${p.kind}`, { type: `agent_${p.kind}`, id: p.targetId },
      () => suspend({ kind: p.kind, targetId: p.targetId, reason: p.reason, by: ctx.staff.id }), { reason: p.reason });
  });
  if (result.ok) { revalidatePath("/agents"); revalidatePath("/agents/negotiations/[id]", "page"); }
  return result;
}

/** Lift an active suspension (agents.suspend; audited, reason required). A lifted mandate returns paused, not active. */
export async function liftSuspensionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const p = z.object({ id: z.uuid(), reason }).parse({ id: fd.get("id"), reason: fd.get("reason") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "agents.suspend");
    await audited(ctx, "agents.suspend", "agents.lift_suspension", { type: "agent_suspension", id: p.id }, () => liftSuspension(p.id, ctx.staff.id), { reason: p.reason });
  });
  if (result.ok) { revalidatePath("/agents"); revalidatePath("/agents/negotiations/[id]", "page"); }
  return result;
}
