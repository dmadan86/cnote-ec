"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { CERT_ITEMS, replayCallback, resolveIssueManually, setCertItem, setKillSwitch, type CertItemId } from "@/lib/ondc";
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

/** Engage or release the per-environment kill switch (audited). Releasing re-queues parked work. */
export async function killSwitchAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const p = z.object({ killed: z.enum(["true", "false"]), note: z.string().trim().max(500).optional() }).parse({ killed: fd.get("killed"), note: fd.get("note") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "ondc.manage");
    await audited(ctx, "ondc.manage", p.killed === "true" ? "ondc.kill_switch_on" : "ondc.kill_switch_off", { type: "ondc_control", id: "killswitch" },
      () => setKillSwitch(p.killed === "true", ctx.staff.id, p.note), { note: p.note ?? null });
  });
  if (result.ok) revalidatePath("/ondc");
  return result;
}

/** Tick or untick a manual ONDC certification checklist item (audited). */
export async function certItemAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const p = z.object({ item: z.enum(CERT_ITEMS.map((i) => i.id) as [CertItemId, ...CertItemId[]]), done: z.enum(["true", "false"]), note: z.string().trim().max(500).optional() })
      .parse({ item: fd.get("item"), done: fd.get("done"), note: fd.get("note") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "ondc.manage");
    await audited(ctx, "ondc.manage", "ondc.cert_item", { type: "ondc_control", id: `cert.${p.item}` }, () => setCertItem(p.item, p.done === "true", ctx.staff.id, p.note), { done: p.done, note: p.note ?? null });
  });
  if (result.ok) revalidatePath("/ondc");
  return result;
}

/** Resolve a network issue that has no dispute behind it (audited); pushes on_issue_status RESOLVED to the buyer app. */
export async function resolveIssueAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const p = z.object({
      id: z.uuid(), action: z.enum(["REFUND", "REPLACEMENT", "NO-ACTION"]), shortDesc: z.string().trim().min(5).max(500),
      refundRupees: z.coerce.number().min(0).max(10_000_000).optional(),
    }).parse({ id: fd.get("id"), action: fd.get("action"), shortDesc: fd.get("shortDesc"), refundRupees: fd.get("refundRupees") || undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "ondc.manage");
    const refundPaise = p.action === "REFUND" && p.refundRupees ? Math.round(p.refundRupees * 100) : undefined;
    await audited(ctx, "ondc.manage", "ondc.resolve_issue", { type: "ondc_issue", id: p.id }, () => resolveIssueManually(p.id, { action: p.action, shortDesc: p.shortDesc, refundPaise }), { action: p.action, refundPaise: refundPaise ?? null });
  });
  if (result.ok) revalidatePath("/ondc");
  return result;
}
