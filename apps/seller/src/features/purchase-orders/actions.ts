"use server";
// Seller-side purchase-order actions (docs/design/purchase-orders.md). Each re-checks the session.
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";
import { enquiry, identity } from "@/lib/services";

export type PoResult = ActionResult<null>;

export async function acknowledgePoAction(_prev: PoResult | null, fd: FormData): Promise<PoResult> {
  const orderId = str(fd, "orderId");
  const session = await requireSeller(`/orders/${orderId}/purchase-order`);
  const decision = str(fd, "decision");
  return run(async () => {
    if (decision !== "accepted" && decision !== "rejected") throw new Error("invalid action");
    await enquiry.acknowledgePurchaseOrder(actorOf(session), str(fd, "purchaseOrderId"), { decision, reason: str(fd, "reason") || null });
    revalidatePath(`/orders/${orderId}`, "layout");
    return null;
  });
}

export async function voidInvoiceAction(_prev: PoResult | null, fd: FormData): Promise<PoResult> {
  const orderId = str(fd, "orderId");
  const session = await requireSeller(`/orders/${orderId}/purchase-order`);
  return run(async () => {
    await enquiry.voidSupplierInvoice(actorOf(session), str(fd, "invoiceId"), str(fd, "reason"));
    revalidatePath(`/orders/${orderId}`, "layout");
    return null;
  });
}

/** Declares (or clears) the business's MSME size class. micro/small needs the explicit confirmation tick. */
export async function msmeAction(_prev: PoResult | null, fd: FormData): Promise<PoResult> {
  const session = await requireSeller("/settings/company");
  const t = await getTranslations("purchaseOrders.msme");
  return run(async () => {
    const raw = str(fd, "category");
    const category = raw === "micro" || raw === "small" || raw === "medium" ? raw : null;
    if ((category === "micro" || category === "small") && str(fd, "confirm") !== "yes") throw new Error(t("confirmRequired"));
    await identity.setMsmeDeclaration(session.business.id, category);
    revalidatePath("/settings/company");
    return null;
  });
}
