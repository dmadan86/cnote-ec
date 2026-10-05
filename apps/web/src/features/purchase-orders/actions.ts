"use server";
// Buyer purchase-order actions (docs/design/purchase-orders.md). Each re-checks the session: server actions are reachable by direct POST.
import { amendPurchaseOrder, cancelPurchaseOrder, issuePurchaseOrder, recordInvoicePayment, type PoDraftInput } from "@cnote/enquiry";
import { actorOf, requireBusiness, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { runLocalized } from "@/i18n/errors";

const text = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const int = (f: FormData, k: string): number | null => {
  const v = text(f, k);
  return v === "" ? null : Number(v);
};

function draft(f: FormData, amend: boolean): PoDraftInput {
  const out: PoDraftInput = { addressId: text(f, "addressId") || null, paymentTermsDays: int(f, "paymentTermsDays"), notes: text(f, "notes") || (amend ? "" : null) };
  const delivery = text(f, "expectedDelivery");
  out.expectedDelivery = delivery || (amend ? null : undefined);
  const rate = int(f, "gstPercent");
  if (rate !== null) out.gstRateBps = Math.round(rate * 100);
  if (text(f, "hsn")) out.hsn = text(f, "hsn");
  return out;
}

export async function issuePoAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = text(f, "orderId");
  const s = await requireBusiness(`/buyer/orders/${orderId}/purchase-order`);
  return runLocalized(async () => {
    await issuePurchaseOrder(actorOf(s), orderId, draft(f, false));
    revalidatePath(`/buyer/orders/${orderId}`, "layout");
  });
}

/** Amends only what the form carries; lines are kept from the previous version (multi-line editing arrives with multi-line RFQs). */
export async function amendPoAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = text(f, "orderId");
  const s = await requireBusiness(`/buyer/orders/${orderId}/purchase-order`);
  return runLocalized(async () => {
    const d = draft(f, true);
    delete d.gstRateBps; // a line-level rate is changed by a new line set, not by this form
    delete d.hsn;
    await amendPurchaseOrder(actorOf(s), text(f, "purchaseOrderId"), d);
    revalidatePath(`/buyer/orders/${orderId}`, "layout");
  });
}

export async function cancelPoAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = text(f, "orderId");
  const s = await requireBusiness(`/buyer/orders/${orderId}/purchase-order`);
  return runLocalized(async () => {
    await cancelPurchaseOrder(actorOf(s), text(f, "purchaseOrderId"), text(f, "reason"));
    revalidatePath(`/buyer/orders/${orderId}`, "layout");
  });
}

export async function payInvoiceAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = text(f, "orderId");
  const s = await requireBusiness("/buyer/payables");
  return runLocalized(async () => {
    const rupees = text(f, "amount");
    const amountPaise = rupees === "" ? null : Math.round(Number(rupees) * 100);
    await recordInvoicePayment(actorOf(s), text(f, "invoiceId"), { amountPaise: amountPaise === null ? undefined : Number.isFinite(amountPaise) ? amountPaise : -1, paidOn: text(f, "paidOn"), reference: text(f, "reference") });
    revalidatePath("/buyer/payables");
    if (orderId) revalidatePath(`/buyer/orders/${orderId}`, "layout");
  });
}
