"use server";
import { audited } from "@cnote/admin";
import { adjudicateDispute, decideAppeal, staffPostDisputeMessage } from "@/lib/disputes";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const adjudicate = z.object({
  disputeId: z.uuid(),
  outcome: z.enum(["buyer_favour", "seller_favour", "split"]),
  accept: z.enum(["on", ""]).optional(),
  refundRupees: z.string().optional(),
  rationale: z.string().trim().min(10, "Give a reason (min 10 characters)").max(2000),
});

/** Decide a dispute: accept the AI recommendation or enter a modified outcome. disputes.adjudicate, audited. Emits DisputeResolved. */
export async function adjudicateAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const i = adjudicate.parse({ disputeId: fd.get("disputeId"), outcome: fd.get("outcome"), accept: String(fd.get("accept") ?? ""), refundRupees: String(fd.get("refundRupees") ?? ""), rationale: fd.get("rationale") });
    const ctx = await actionContext();
    const refundPaise = i.refundRupees?.trim() ? Math.round(Number(i.refundRupees) * 100) : undefined;
    await audited(
      ctx, "disputes.adjudicate", "dispute.adjudicate", { type: "dispute", id: i.disputeId },
      () => adjudicateDispute(ctx.staff.personId, i.disputeId, { outcome: i.outcome, refundPaise, rationale: i.rationale, acceptRecommendation: i.accept === "on" }),
      { outcome: i.outcome, acceptRecommendation: i.accept === "on", refundPaise: refundPaise ?? null },
    );
  });
  if (result.ok) { revalidatePath("/disputes"); revalidatePath(`/disputes/${fd.get("disputeId")}`); }
  return result;
}

const appeal = z.object({
  disputeId: z.uuid(), appealId: z.uuid(), status: z.enum(["upheld", "modified"]),
  note: z.string().trim().min(10, "Give a reason (min 10 characters)").max(2000),
  newOutcome: z.enum(["buyer_favour", "seller_favour", "split"]).optional(),
  newRefundRupees: z.string().optional(),
  atStakeRupees: z.coerce.number().min(0),
});

/** Second review of an appeal. Does not re-emit DisputeResolved (finance settles a modified outcome). disputes.adjudicate, audited. */
export async function appealAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const i = appeal.parse({
      disputeId: fd.get("disputeId"), appealId: fd.get("appealId"), status: fd.get("status"), note: fd.get("note"),
      newOutcome: fd.get("newOutcome") || undefined, newRefundRupees: String(fd.get("newRefundRupees") ?? ""), atStakeRupees: fd.get("atStakeRupees"),
    });
    const ctx = await actionContext();
    const atStake = Math.round(i.atStakeRupees * 100);
    const refund = i.newOutcome === "buyer_favour" ? atStake : i.newOutcome === "seller_favour" ? 0 : Math.round(Number(i.newRefundRupees || 0) * 100);
    await audited(
      ctx, "disputes.adjudicate", "dispute.appeal.decide", { type: "dispute_appeal", id: i.appealId },
      () => decideAppeal(ctx.staff.personId, i.appealId, i.status === "upheld" ? { status: "upheld", note: i.note } : { status: "modified", note: i.note, newOutcome: i.newOutcome, newRefundPaise: refund, newReleasePaise: atStake - refund }),
      { status: i.status, newOutcome: i.newOutcome ?? null },
    );
  });
  if (result.ok) revalidatePath(`/disputes/${fd.get("disputeId")}`);
  return result;
}

const message = z.object({ disputeId: z.uuid(), partyBusinessId: z.uuid(), body: z.string().trim().min(1).max(2000) });

/** Staff message into one party's private thread. disputes.adjudicate, audited. */
export async function messageAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const i = message.parse({ disputeId: fd.get("disputeId"), partyBusinessId: fd.get("partyBusinessId"), body: fd.get("body") });
    const ctx = await actionContext();
    await audited(ctx, "disputes.adjudicate", "dispute.message", { type: "dispute", id: i.disputeId }, () => staffPostDisputeMessage(ctx.staff.personId, i.disputeId, i.partyBusinessId, i.body), { partyBusinessId: i.partyBusinessId });
  });
  if (result.ok) revalidatePath(`/disputes/${fd.get("disputeId")}`);
  return result;
}
