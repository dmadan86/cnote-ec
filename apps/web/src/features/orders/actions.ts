"use server";
// Buyer-side order actions. Each re-checks the session: server actions are reachable by direct POST.
import { confirmOrder, transitionOrder, type OrderMove } from "@cnote/enquiry";
import { actorOf, requireBusiness, runAction, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

const MOVES: readonly string[] = ["delivered", "completed", "cancelled"];

export async function orderAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = String(f.get("orderId") ?? "");
  const intent = String(f.get("intent") ?? "");
  const s = await requireBusiness(`/buyer/orders/${orderId}`);
  return runAction(async () => {
    if (intent === "confirm") await confirmOrder(actorOf(s), orderId);
    else if (MOVES.includes(intent)) await transitionOrder(actorOf(s), orderId, intent as OrderMove);
    else throw new Error("invalid action");
    revalidatePath(`/buyer/orders/${orderId}`);
    revalidatePath("/buyer/orders");
  });
}
