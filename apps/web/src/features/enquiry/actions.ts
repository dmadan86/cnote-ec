"use server";
// Buyer-side server actions. Each re-checks the session: server actions are reachable by direct POST.
import { awardLines, pickSellers, createEnquiry, decideQuote, reportDeal, sendMessage, setQuoteShortlisted, type AttachmentUpload, type EnquiryView } from "@cnote/enquiry";
import { actorOf, requireBusiness, type ActionResult } from "@cnote/next-kit";
import { clientIp } from "@cnote/security/client-ip";
import { headers } from "next/headers";
import { runLocalized } from "@/i18n/errors";
import { revalidatePath } from "next/cache";
import { attributeEnquiryFromCookie } from "@/features/ads/slots";
import { linesFromForm } from "./bom";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const num = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === undefined ? undefined : Number(v);
};

const paise = (rupees: number | undefined) => (rupees === undefined || Number.isNaN(rupees) ? undefined : Math.round(rupees * 100));

async function files(f: FormData, field: string): Promise<AttachmentUpload[]> {
  const out: AttachmentUpload[] = [];
  for (const v of f.getAll(field)) {
    if (typeof v === "string" || v.size === 0) continue; // an empty file input submits one zero-byte entry
    out.push({ fileName: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  return out;
}

/** "Post your requirement". Prices are entered in ₹ and stored as integer paise; drawings go to private storage. */
export async function postRfqAction(_prev: ActionResult<EnquiryView> | null, f: FormData): Promise<ActionResult<EnquiryView>> {
  const s = await requireBusiness("/rfq/new");
  const rupees = num(f, "targetPrice");
  return runLocalized(async () => {
    const enquiry = await createEnquiry(
      actorOf(s),
      {
        title: str(f, "title") ?? "",
        requirement: str(f, "requirement") ?? "",
        lines: linesFromForm(f),
        categorySlug: str(f, "categorySlug"),
        quantity: num(f, "quantity"),
        quantityUnit: str(f, "quantityUnit"),
        targetPricePaise: paise(rupees),
        budgetMinPaise: paise(num(f, "budgetMin")),
        budgetMaxPaise: paise(num(f, "budgetMax")),
        expiresInDays: num(f, "expiresInDays"),
        minSellerTier: num(f, "minSellerTier"),
        attachments: await files(f, "attachments"),
        deliveryCity: str(f, "deliveryCity"),
        deliveryPincode: str(f, "deliveryPincode"),
        neededBy: str(f, "neededBy"),
        buyerPicks: f.get("buyerPicks") === "on",
        preferredListingId: str(f, "preferredListingId"),
        preferredSellerId: str(f, "preferredSellerId"),
        language: s.preferredLanguage,
      },
      { buyerPhoneVerified: s.phoneVerified, ip: clientIp(await headers()), userAgent: (await headers()).get("user-agent") },
    );
    await attributeEnquiryFromCookie({ enquiryId: enquiry.id, buyerBusinessId: s.business.id, listingId: str(f, "preferredListingId") });
    revalidatePath("/buyer/enquiries");
    return enquiry;
  });
}

export async function pickSellersAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness("/buyer/enquiries");
  const enquiryId = str(f, "enquiryId") ?? "";
  return runLocalized(async () => {
    await pickSellers(actorOf(s), enquiryId, f.getAll("sellerId").filter((v): v is string => typeof v === "string"));
    revalidatePath(`/buyer/enquiries/${enquiryId}`);
  });
}

export async function sendMessageAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const conversationId = str(f, "conversationId") ?? "";
  const s = await requireBusiness(`/conversations/${conversationId}`);
  return runLocalized(async () => {
    await sendMessage(actorOf(s), conversationId, String(f.get("body") ?? ""));
    revalidatePath(`/conversations/${conversationId}`);
  });
}

export async function reportDealAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const conversationId = str(f, "conversationId") ?? "";
  const s = await requireBusiness(`/conversations/${conversationId}`);
  const outcome = str(f, "outcome");
  return runLocalized(async () => {
    if (outcome !== "won" && outcome !== "lost" && outcome !== "pending") throw new Error("invalid outcome");
    await reportDeal(actorOf(s), str(f, "matchId") ?? "", outcome);
    revalidatePath(`/conversations/${conversationId}`);
  });
}

/** Quote comparison actions (buyer). The deal value is computed server-side from the stored quote. */
export async function quoteDecisionAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(`/buyer/enquiries/${enquiryId}`);
  const decision = str(f, "decision");
  return runLocalized(async () => {
    if (decision !== "accept" && decision !== "decline") throw new Error("invalid decision");
    await decideQuote(actorOf(s), str(f, "quoteId") ?? "", decision);
    revalidatePath(`/buyer/enquiries/${enquiryId}`);
  });
}

export async function shortlistQuoteAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(`/buyer/enquiries/${enquiryId}`);
  return runLocalized(async () => {
    await setQuoteShortlisted(actorOf(s), str(f, "quoteId") ?? "", f.get("shortlisted") === "true");
    revalidatePath(`/buyer/enquiries/${enquiryId}`);
  });
}

/** Per-line award (rfq-multiline): `award` fields are "<enquiryLineId>:<quoteId>". Amounts come from the stored, server-computed line totals. */
export async function awardLinesAction(_prev: ActionResult<{ orders: number }> | null, f: FormData): Promise<ActionResult<{ orders: number }>> {
  const enquiryId = str(f, "enquiryId") ?? "";
  const s = await requireBusiness(`/buyer/enquiries/${enquiryId}`);
  return runLocalized(async () => {
    const awards = f.getAll("award").flatMap((v) => {
      const [enquiryLineId, quoteId] = String(v).split(":");
      return enquiryLineId && quoteId ? [{ enquiryLineId, quoteId }] : [];
    });
    const { results } = await awardLines(actorOf(s), enquiryId, awards);
    revalidatePath(`/buyer/enquiries/${enquiryId}`);
    return { orders: results.length };
  });
}
