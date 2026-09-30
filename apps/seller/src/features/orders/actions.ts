"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { FULFILMENT_STAGES, type FulfilmentStage, type OrderMove } from "@cnote/enquiry";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";
import { enquiry } from "@/lib/services";

export type OrderResult = ActionResult<null>;
const MOVES: readonly string[] = ["dispatched", "cancelled"];

/** Seller-side order actions: confirm the terms, mark dispatched, or cancel before dispatch. */
export async function orderAction(_prev: OrderResult | null, fd: FormData): Promise<OrderResult> {
  const orderId = String(fd.get("orderId") ?? "");
  const intent = String(fd.get("intent") ?? "");
  const session = await requireSeller(`/orders/${orderId}`);
  const t = await getTranslations("orders");
  return run(async () => {
    if (intent === "confirm") await enquiry.confirmOrder(actorOf(session), orderId);
    else if (MOVES.includes(intent)) await enquiry.transitionOrder(actorOf(session), orderId, intent as OrderMove);
    else throw new Error(t("invalidAction"));
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/orders");
    return null;
  });
}

/** Seller records the next fulfilment step (never changes the order status). */
export async function fulfilmentAction(_prev: OrderResult | null, fd: FormData): Promise<OrderResult> {
  const orderId = String(fd.get("orderId") ?? "");
  const stage = String(fd.get("stage") ?? "");
  const session = await requireSeller(`/orders/${orderId}`);
  const t = await getTranslations("orders.fulfilment");
  return run(async () => {
    if (!(FULFILMENT_STAGES as readonly string[]).includes(stage)) throw new Error(t("invalidStage"));
    const text = (k: string) => { const v = fd.get(k); return typeof v === "string" ? v : null; };
    await enquiry.recordFulfilmentStage(actorOf(session), orderId, { stage: stage as FulfilmentStage, note: text("note"), courier: text("courier"), trackingRef: text("trackingRef") });
    revalidatePath(`/orders/${orderId}`);
    return null;
  });
}
