import "server-only";
// "Post your requirement", shared by the text-only server action (actions.ts) and the multipart route handler (app/api/rfq/route.ts).
import { createEnquiry, MAX_RFQ_ATTACHMENTS, MAX_RFQ_ATTACHMENT_BYTES, type AttachmentUpload, type EnquiryView } from "@cnote/enquiry";
import { actorOf, type SessionWithBusiness } from "@cnote/next-kit";
import { clientIp } from "@cnote/security/client-ip";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { attributeEnquiryFromCookie } from "@/features/ads/slots";

/** Whole-request cap for the upload route: every allowed attachment at full size plus form fields and multipart framing. */
export const RFQ_UPLOAD_MAX_BYTES = MAX_RFQ_ATTACHMENTS * MAX_RFQ_ATTACHMENT_BYTES + 512 * 1024;

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

/** `withFiles` is true only on the route handler, which has its own body cap; the server action (2 MB cap) refuses files outright. */
export async function postRfq(f: FormData, s: SessionWithBusiness, opts: { withFiles?: boolean } = {}): Promise<EnquiryView> {
  const attachments = await files(f, "attachments");
  if (attachments.length && !opts.withFiles) throw new Error("Drawings must be uploaded through the attachment upload, not a plain form post.");
  const rupees = num(f, "targetPrice");
  const enquiry = await createEnquiry(
    actorOf(s),
    {
      title: str(f, "title") ?? "",
      requirement: str(f, "requirement") ?? "",
      categorySlug: str(f, "categorySlug"),
      quantity: num(f, "quantity"),
      quantityUnit: str(f, "quantityUnit"),
      targetPricePaise: paise(rupees),
      budgetMinPaise: paise(num(f, "budgetMin")),
      budgetMaxPaise: paise(num(f, "budgetMax")),
      expiresInDays: num(f, "expiresInDays"),
      minSellerTier: num(f, "minSellerTier"),
      attachments,
      deliveryCity: str(f, "deliveryCity"),
      deliveryPincode: str(f, "deliveryPincode"),
      neededBy: str(f, "neededBy"),
      buyerPicks: f.get("buyerPicks") === "on",
      preferredListingId: str(f, "preferredListingId"),
      preferredSellerId: str(f, "preferredSellerId"),
      language: s.preferredLanguage,
    },
    // ADR-002 fake-lead signals: server-side only (hashed /24, UA family, velocity). Nothing is set in the browser.
    { buyerPhoneVerified: s.phoneVerified, ip: clientIp(await headers()), userAgent: (await headers()).get("user-agent") },
  );
  await attributeEnquiryFromCookie({ enquiryId: enquiry.id, buyerBusinessId: s.business.id, listingId: str(f, "preferredListingId") });
  revalidatePath("/buyer/enquiries");
  return enquiry;
}
