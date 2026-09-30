"use server";
// Buyer BNPL actions (ADR-019). Each re-checks the session. Consent is an explicit checkbox; acceptance is a separate
// explicit step that carries the KFS acknowledgement.
import { acceptOffer, actorHasCreditConsent, applyForFinancing, cancelLoanInCoolingOff, declineOffer, grantCreditConsent, simulateMockDisbursal } from "@cnote/credit";
import { actorOf, requireBusiness, runAction, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

const INTENTS = ["apply", "accept", "decline", "simulate", "exit"] as const;

export async function bnplAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const orderId = String(f.get("orderId") ?? "");
  const intent = String(f.get("intent") ?? "");
  const s = await requireBusiness(`/buyer/orders/${orderId}`);
  return runAction(async () => {
    if (!(INTENTS as readonly string[]).includes(intent)) throw new Error("invalid action");
    const actor = actorOf(s);
    if (intent === "apply") {
      if (!(await actorHasCreditConsent(actor))) {
        if (f.get("consent") !== "on") throw new Error("Please tick the consent box to continue.");
        await grantCreditConsent(actor, "buyer_bnpl");
      }
      await applyForFinancing(actor, { product: "bnpl", escrowId: String(f.get("escrowId") ?? ""), tenorDays: Number(f.get("tenorDays") ?? 30) });
    } else if (intent === "accept") {
      await acceptOffer(actor, { offerId: String(f.get("offerId") ?? ""), acknowledgedKfs: f.get("acknowledge") === "on", kfsVersion: String(f.get("kfsVersion") ?? "") });
    } else if (intent === "exit") {
      await cancelLoanInCoolingOff(actor, { loanId: String(f.get("loanId") ?? ""), confirmExit: f.get("confirmExit") === "on", expectedPayablePaise: Number(f.get("expectedPayablePaise") ?? -1) });
    } else if (intent === "decline") await declineOffer(actor, String(f.get("offerId") ?? ""));
    else await simulateMockDisbursal(String(f.get("applicationId") ?? ""));
    revalidatePath(`/buyer/orders/${orderId}`);
  });
}
