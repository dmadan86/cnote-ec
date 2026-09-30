"use server";
// Buyer report "seller did not honour this offer". Re-checks the session (server actions are reachable by direct POST).
import { reportOfferNotHonoured } from "@cnote/promotions";
import { type ActionResult, currentSession } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { z } from "zod";

const input = z.object({ offerId: z.uuid(), note: z.string().trim().max(1000).optional() });

export async function reportOfferAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await currentSession();
  if (!s?.business) return { ok: false, error: "Please sign in with a business account to report an offer." };
  const businessId = s.business.id;
  return runLocalized(async () => {
    const d = input.parse({ offerId: f.get("offerId"), note: typeof f.get("note") === "string" ? f.get("note") : undefined });
    await reportOfferNotHonoured({ offerId: d.offerId, reporterBusinessId: businessId, note: d.note ?? null });
  });
}
