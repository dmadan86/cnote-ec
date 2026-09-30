"use server";
// Buyer escrow actions (ADR-012). Each re-checks the session: server actions are reachable by direct POST.
import { acceptDelivery, createEscrowForOrder, simulateMockFunding } from "@cnote/escrow";
import { actorOf, requireBusiness, runAction, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

const INTENTS = ["start", "pay_mock", "accept"] as const;

export async function escrowAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = String(f.get("orderId") ?? "");
  const intent = String(f.get("intent") ?? "");
  const s = await requireBusiness(`/buyer/orders/${orderId}`);
  return runAction(async () => {
    if (!(INTENTS as readonly string[]).includes(intent)) throw new Error("invalid action");
    const actor = actorOf(s);
    if (intent === "start") await createEscrowForOrder(actor, orderId);
    else if (intent === "pay_mock") await simulateMockFunding(actor, orderId);
    else await acceptDelivery(actor, orderId);
    revalidatePath(`/buyer/orders/${orderId}`);
    revalidatePath("/buyer/orders");
  });
}
