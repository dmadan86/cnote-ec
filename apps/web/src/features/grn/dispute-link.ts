import "server-only";
import { getGoodsReturn, type Actor } from "@cnote/enquiry";
import { DomainError } from "@cnote/core";

/** Reason code of a return -> the closest dispute type (the dispute classifier and ops can re-type it). */
const DISPUTE_TYPE: Record<string, string> = {
  damaged: "damaged", short: "quantity_short", wrong_spec: "wrong_item", quality_fail: "quality_mismatch", not_as_ordered: "wrong_item", other: "other",
};

export async function getReturnForDispute(actor: Actor, id: string): Promise<{ orderId: string; number: string; decisionNote: string | null; disputeType: string }> {
  const r = await getGoodsReturn(actor, id);
  if (!r || r.role !== "buyer") throw new DomainError("not_found", "Return not found");
  if (!r.actions.dispute) throw new DomainError("conflict", "A dispute can only be opened for a rejected return that has none yet.");
  return { orderId: r.orderId, number: r.number, decisionNote: r.decisionNote, disputeType: DISPUTE_TYPE[r.reasonCode] ?? "other" };
}
