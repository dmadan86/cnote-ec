"use server";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { DomainError, rateLimit } from "@cnote/core";
import { estimateFreight, freightEstimatorEnabled, type FreightEstimate } from "@cnote/logistics";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";
import { catalogue, enquiry, identity } from "@/lib/services";

export type FreightSuggestion = Pick<FreightEstimate, "mode" | "lowPaise" | "highPaise" | "midPaise" | "transitDays" | "assumptions">;
export type FreightResult = ActionResult<FreightSuggestion>;

/**
 * "Suggest freight" on the quote form: estimates freight from the seller's pincode to the buyer's delivery pincode for the
 * quantity typed in the form, using the seller's own listing weight when known. Estimate only; the seller edits the charge.
 */
export async function suggestFreightAction(_prev: FreightResult | null, fd: FormData): Promise<FreightResult> {
  const conversationId = str(fd, "conversationId");
  const session = await requireSeller(`/conversations/${conversationId}`);
  const t = await getTranslations("freight");
  return run(async () => {
    if (!freightEstimatorEnabled()) throw new DomainError("conflict", t("failed"));
    const quantity = Math.ceil(Number(str(fd, "quantity")));
    if (!Number.isFinite(quantity) || quantity < 1) throw new DomainError("validation", t("needQuantity"));
    if (!(await rateLimit(`freight:seller:${session.personId}`, 40, 3600))) throw new DomainError("rate_limited", t("failed"));
    const actor = actorOf(session);
    const convo = await enquiry.getConversation(actor, z.string().min(1).parse(conversationId));
    const lead = convo ? await enquiry.getSellerLead(session.business.id, convo.matchId) : null;
    const destination = lead?.enquiry.deliveryPincode ?? null;
    if (!destination) throw new DomainError("validation", t("needPincode"));
    const [profile, facts] = await Promise.all([
      identity.getTrustProfiles([session.business.id]).then((m) => m.get(session.business.id) ?? null),
      catalogue.getSellerShippingFacts(session.business.id, lead?.enquiry.category?.slug ?? null),
    ]);
    const e = await estimateFreight({
      originPincode: profile?.pincode ?? null,
      destinationPincode: destination,
      quantity,
      unitWeightGrams: facts?.unitWeightGrams ?? null,
      unitLengthMm: facts?.unitLengthMm ?? null,
      unitWidthMm: facts?.unitWidthMm ?? null,
      unitHeightMm: facts?.unitHeightMm ?? null,
    });
    return { mode: e.mode, lowPaise: e.lowPaise, highPaise: e.highPaise, midPaise: e.midPaise, transitDays: e.transitDays, assumptions: e.assumptions };
  });
}
