"use server";
// Buyer goods-receipt / match / return actions (docs/design/grn-returns.md). Each re-checks the session: server actions are reachable by direct POST.
// Receipts with photos go through app/api/goods-receipts (multipart, own body cap), not through here.
import { cancelReturn, linkReturnDispute, recordReturnShipment, requestReturn, setBuyerMatchSettings, type ReturnLineInput } from "@cnote/enquiry";
import { actorOf, requireBusiness, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { getReturnForDispute } from "./dispute-link";
import { runLocalized } from "@/i18n/errors";
import { openDispute } from "@/lib/disputes";

const text = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/** Tolerances are entered as percentages (0 to 20, up to two decimals). */
export async function matchSettingsAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = text(f, "orderId");
  const s = await requireBusiness(`/buyer/orders/${orderId}/match`);
  return runLocalized(async () => {
    await setBuyerMatchSettings(actorOf(s), {
      qtyToleranceBps: Math.round(Number(text(f, "qtyTolerance") || "NaN") * 100),
      priceToleranceBps: Math.round(Number(text(f, "priceTolerance") || "NaN") * 100),
      blockPendingGrn: f.get("blockPendingGrn") === "on",
    });
    revalidatePath(`/buyer/orders/${orderId}`, "layout");
    revalidatePath("/buyer/payables");
  });
}

/** Fields: `qty__<receiptLineId>__<rejected|accepted>` hold the units to return. */
export async function requestReturnAction(_prev: ActionResult<{ id: string }> | null, f: FormData): Promise<ActionResult<{ id: string }>> {
  const receiptId = text(f, "receiptId");
  const s = await requireBusiness(`/buyer/returns/new?receipt=${receiptId}`);
  return runLocalized(async () => {
    const lines: ReturnLineInput[] = [];
    for (const [k, v] of f.entries()) {
      const m = /^qty__([0-9a-f-]{36})__(rejected|accepted)$/.exec(k);
      if (!m || typeof v !== "string" || v.trim() === "") continue;
      lines.push({ receiptLineId: m[1]!, source: m[2] as "rejected" | "accepted", quantity: Number(v) });
    }
    const r = await requestReturn(actorOf(s), { receiptId, reasonCode: text(f, "reasonCode"), note: text(f, "note") || null, lines });
    revalidatePath("/buyer/returns");
    return { id: r.id };
  });
}

export async function cancelReturnAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "returnId");
  const s = await requireBusiness(`/buyer/returns/${id}`);
  return runLocalized(async () => {
    await cancelReturn(actorOf(s), id);
    revalidatePath("/buyer/returns", "layout");
  });
}

export async function shipReturnAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "returnId");
  const s = await requireBusiness(`/buyer/returns/${id}`);
  return runLocalized(async () => {
    await recordReturnShipment(actorOf(s), id, { courier: text(f, "courier") || null, trackingRef: text(f, "trackingRef") });
    revalidatePath("/buyer/returns", "layout");
  });
}

/**
 * Open a dispute about a REJECTED return: the dispute itself is @cnote/disputes' (evidence, mediation, escrow freeze); this only opens it
 * with the return's facts and stores the link on the return.
 */
export async function returnDisputeAction(_prev: ActionResult<{ disputeId: string }> | null, f: FormData): Promise<ActionResult<{ disputeId: string }>> {
  const id = text(f, "returnId");
  const s = await requireBusiness(`/buyer/returns/${id}`);
  return runLocalized(async () => {
    const actor = actorOf(s);
    const r = await getReturnForDispute(actor, id);
    const d = await openDispute(actor, {
      orderId: r.orderId,
      type: r.disputeType as never,
      description: [`Return ${r.number} was rejected by the seller.`, r.decisionNote ? `Seller's reason: ${r.decisionNote}` : "", text(f, "text")].filter(Boolean).join("\n"),
      language: "en",
    });
    await linkReturnDispute(actor, id, d.id);
    revalidatePath("/buyer/returns", "layout");
    revalidatePath("/buyer/orders", "layout");
    return { disputeId: d.id };
  });
}
