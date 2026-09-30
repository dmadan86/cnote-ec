"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import type { OrderMove } from "@cnote/enquiry";
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
