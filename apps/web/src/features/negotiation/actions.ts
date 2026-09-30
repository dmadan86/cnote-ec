"use server";
// Buyer-side negotiation assist actions (ADR-014). Each re-checks the session. Nothing here contacts a seller except
// sendCounterAction, which the buyer triggers explicitly; bounds are enforced again server-side inside @cnote/negotiation.
import { actorOf, requireBusiness, type ActionResult } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { discardCounterOffer, proposeCounterOffer, sendCounterOffer, setBuyerBounds } from "@cnote/negotiation";
import { revalidatePath } from "next/cache";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const rupeesToPaise = (f: FormData, k: string): number | null => {
  const v = str(f, k);
  if (v === undefined) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
};
const days = (f: FormData, k: string): number | null => {
  const v = str(f, k);
  return v === undefined ? null : Number(v);
};
const page = (enquiryId: string) => `/buyer/enquiries/${enquiryId}`;

export async function setBoundsAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(page(enquiryId));
  return runLocalized(async () => {
    await setBuyerBounds(actorOf(s), enquiryId, { targetPricePaise: rupeesToPaise(f, "target"), ceilingPricePaise: rupeesToPaise(f, "ceiling"), maxLeadTimeDays: days(f, "maxLead") });
    revalidatePath(page(enquiryId));
  });
}

export async function suggestCounterAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(page(enquiryId));
  return runLocalized(async () => {
    await proposeCounterOffer(actorOf(s), enquiryId, str(f, "quoteId") ?? "");
    revalidatePath(page(enquiryId));
  });
}

/** The explicit "Send" press: re-checks the (possibly edited) counter against the buyer's bounds, then posts it as a message. */
export async function sendCounterAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(page(enquiryId));
  return runLocalized(async () => {
    await sendCounterOffer(actorOf(s), str(f, "proposalId") ?? "", {
      pricePaise: rupeesToPaise(f, "price") ?? undefined,
      leadTimeDays: days(f, "lead"),
      note: str(f, "note") ?? "",
    });
    revalidatePath(page(enquiryId));
  });
}

export async function discardCounterAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(page(enquiryId));
  return runLocalized(async () => {
    await discardCounterOffer(actorOf(s), str(f, "proposalId") ?? "");
    revalidatePath(page(enquiryId));
  });
}
