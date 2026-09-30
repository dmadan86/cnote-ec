"use server";
// Buyer-side server actions. Each re-checks the session: server actions are reachable by direct POST.
import { pickSellers, createEnquiry, reportDeal, sendMessage, type EnquiryView } from "@cnote/enquiry";
import { actorOf, requireBusiness, runAction, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const num = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === undefined ? undefined : Number(v);
};

/** "Post your requirement". Target price is entered in ₹ and stored as integer paise. */
export async function postRfqAction(_prev: ActionResult<EnquiryView> | null, f: FormData): Promise<ActionResult<EnquiryView>> {
  const s = await requireBusiness("/rfq/new");
  const rupees = num(f, "targetPrice");
  return runAction(async () => {
    const enquiry = await createEnquiry(
      actorOf(s),
      {
        title: str(f, "title") ?? "",
        requirement: str(f, "requirement") ?? "",
        categorySlug: str(f, "categorySlug"),
        quantity: num(f, "quantity"),
        quantityUnit: str(f, "quantityUnit"),
        targetPricePaise: rupees === undefined || Number.isNaN(rupees) ? undefined : Math.round(rupees * 100),
        deliveryCity: str(f, "deliveryCity"),
        deliveryPincode: str(f, "deliveryPincode"),
        neededBy: str(f, "neededBy"),
        buyerPicks: f.get("buyerPicks") === "on",
        preferredListingId: str(f, "preferredListingId"),
        preferredSellerId: str(f, "preferredSellerId"),
        language: s.preferredLanguage,
      },
      { buyerPhoneVerified: s.phoneVerified },
    );
    revalidatePath("/buyer/enquiries");
    return enquiry;
  });
}

export async function pickSellersAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness("/buyer/enquiries");
  const enquiryId = str(f, "enquiryId") ?? "";
  return runAction(async () => {
    await pickSellers(actorOf(s), enquiryId, f.getAll("sellerId").filter((v): v is string => typeof v === "string"));
    revalidatePath(`/buyer/enquiries/${enquiryId}`);
  });
}

export async function sendMessageAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const conversationId = str(f, "conversationId") ?? "";
  const s = await requireBusiness(`/conversations/${conversationId}`);
  return runAction(async () => {
    await sendMessage(actorOf(s), conversationId, String(f.get("body") ?? ""));
    revalidatePath(`/conversations/${conversationId}`);
  });
}

export async function reportDealAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const conversationId = str(f, "conversationId") ?? "";
  const s = await requireBusiness(`/conversations/${conversationId}`);
  const outcome = str(f, "outcome");
  return runAction(async () => {
    if (outcome !== "won" && outcome !== "lost" && outcome !== "pending") throw new Error("invalid outcome");
    await reportDeal(actorOf(s), str(f, "matchId") ?? "", outcome);
    revalidatePath(`/conversations/${conversationId}`);
  });
}
