"use server";
import { audited } from "@cnote/admin";
import { reconcile, resolveIssue, staffRefundEscrow, staffReleaseEscrow } from "@cnote/escrow";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const money = z.object({ escrowId: z.uuid(), reason: z.string().trim().min(3, "Give a reason (min 3 characters)").max(300) });

/** Manual release of everything held to the seller. escrow.manage, audited. Refused while a dispute is open. */
export async function releaseEscrowAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = money.parse({ escrowId: fd.get("escrowId"), reason: fd.get("reason") });
    const ctx = await actionContext();
    await audited(ctx, "escrow.manage", "escrow.release", { type: "escrow", id: input.escrowId }, () => staffReleaseEscrow(input.escrowId), { reason: input.reason });
  });
  if (result.ok) { revalidatePath("/escrow"); revalidatePath(`/escrow/${fd.get("escrowId")}`); }
  return result;
}

/** Manual refund of everything held to the buyer. escrow.manage, audited. Refused while a dispute is open. */
export async function refundEscrowAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = money.parse({ escrowId: fd.get("escrowId"), reason: fd.get("reason") });
    const ctx = await actionContext();
    await audited(ctx, "escrow.manage", "escrow.refund", { type: "escrow", id: input.escrowId }, () => staffRefundEscrow(input.escrowId), { reason: input.reason });
  });
  if (result.ok) { revalidatePath("/escrow"); revalidatePath(`/escrow/${fd.get("escrowId")}`); }
  return result;
}

const resolve = z.object({ issueId: z.uuid(), note: z.string().trim().min(3, "Add a resolution note (min 3 characters)").max(500) });

/** Close a reconciliation issue with a note. escrow.manage, audited. */
export async function resolveIssueAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = resolve.parse({ issueId: fd.get("issueId"), note: fd.get("note") });
    const ctx = await actionContext();
    await audited(ctx, "escrow.manage", "escrow.issue.resolve", { type: "escrow_issue", id: input.issueId }, () => resolveIssue(input.issueId, ctx.staff.id, input.note), { note: input.note });
  });
  if (result.ok) revalidatePath("/escrow/reconciliation");
  return result;
}

/** Run the partner-vs-ledger comparison now. escrow.manage, audited. */
export async function runReconciliationAction(..._args: [ActionResult | null, FormData?]): Promise<ActionResult> {
  void _args;
  const result = await runAction(async () => {
    const ctx = await actionContext();
    await audited(ctx, "escrow.manage", "escrow.reconcile", { type: "escrow", id: "reconciliation" }, () => reconcile(), {});
  });
  if (result.ok) revalidatePath("/escrow/reconciliation");
  return result;
}
