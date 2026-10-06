"use server";
// Seller-side sample actions (docs/design/samples.md): accept, decline, dispatch, mark delivered, record payment. Each re-checks the session.
import { revalidatePath } from "next/cache";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";
import { acceptSample, declineSample, dispatchSample, markSampleDelivered, recordSamplePayment, DECLINE_REASONS, type DeclineReason } from "@/lib/samples";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

export async function sampleAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = String(f.get("sampleId") ?? "");
  const session = await requireSeller(`/samples/${id}`);
  const actor = actorOf(session);
  const intent = String(f.get("intent") ?? "");
  const r = await run(async () => {
    if (intent === "accept") {
      const rupees = str(f, "amountRupees");
      const amount = rupees === undefined ? undefined : Math.round(Number(rupees) * 100);
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) throw new Error("Enter the sample price in rupees, 0 or more.");
      await acceptSample(actor, id, { amountPaise: amount, adjustableAgainstBulk: f.get("adjustable") === "on", paymentNote: str(f, "paymentNote") ?? null });
    } else if (intent === "decline") {
      const reason = String(f.get("reason") ?? "") as DeclineReason;
      await declineSample(actor, id, { reason: (DECLINE_REASONS as readonly string[]).includes(reason) ? reason : ("" as DeclineReason), note: str(f, "note") ?? null });
    } else if (intent === "dispatch") await dispatchSample(actor, id, { courier: str(f, "courier") ?? "", trackingRef: str(f, "trackingRef") ?? null });
    else if (intent === "delivered") await markSampleDelivered(actor, id);
    else if (intent === "payment") await recordSamplePayment(actor, id, str(f, "paymentNote"));
    else throw new Error("invalid action");
  });
  if (r.ok) {
    revalidatePath(`/samples/${id}`);
    revalidatePath("/samples");
  }
  return r;
}
