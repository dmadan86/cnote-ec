"use server";
// Seller credit actions (ADR-019). Each re-checks the session: server actions are reachable by direct POST.
// Acceptance is always an explicit, separate action that carries the KFS acknowledgement; nothing is auto-accepted.
import { revalidatePath } from "next/cache";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { acceptOffer, applyForFinancing, cancelLoanInCoolingOff, declineOffer, grantCreditConsent, simulateMockDisbursal, withdrawCreditConsent } from "@cnote/credit";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";

export type CreditResult = ActionResult<null>;
const INTENTS = ["grant", "withdraw", "apply", "accept", "decline", "simulate", "exit"] as const;

export async function creditAction(_prev: CreditResult | null, fd: FormData): Promise<CreditResult> {
  const session = await requireSeller("/credit");
  const actor = actorOf(session);
  const intent = String(fd.get("intent") ?? "");
  return run(async () => {
    if (!(INTENTS as readonly string[]).includes(intent)) throw new Error("invalid action");
    if (intent === "grant") await grantCreditConsent(actor, "seller_portal");
    else if (intent === "withdraw") await withdrawCreditConsent(actor, "seller_portal");
    else if (intent === "apply") {
      const rupees = String(fd.get("amountRupees") ?? "").trim();
      const amountPaise = rupees ? Math.round(Number(rupees) * 100) : undefined;
      if (amountPaise !== undefined && (!Number.isFinite(amountPaise) || amountPaise <= 0)) throw new Error("Enter a valid amount.");
      await applyForFinancing(actor, { product: "invoice_financing", escrowId: String(fd.get("escrowId") ?? ""), tenorDays: Number(fd.get("tenorDays") ?? 30), amountPaise });
    } else if (intent === "accept") {
      await acceptOffer(actor, { offerId: String(fd.get("offerId") ?? ""), acknowledgedKfs: fd.get("acknowledge") === "on", kfsVersion: String(fd.get("kfsVersion") ?? "") });
    } else if (intent === "exit") {
      // cooling-off exit (RBI): explicit confirmation of the exact amount that was shown
      await cancelLoanInCoolingOff(actor, { loanId: String(fd.get("loanId") ?? ""), confirmExit: fd.get("confirmExit") === "on", expectedPayablePaise: Number(fd.get("expectedPayablePaise") ?? -1) });
    } else if (intent === "decline") await declineOffer(actor, String(fd.get("offerId") ?? ""));
    else await simulateMockDisbursal(actor, String(fd.get("applicationId") ?? ""));
    revalidatePath("/credit");
    return null;
  });
}
