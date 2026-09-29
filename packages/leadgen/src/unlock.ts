import { createEnquiry } from "@cnote/enquiry";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { createBusiness } from "@cnote/identity";
import { getCapture, markConverted } from "./capture";
import { unlockDetailsSchema, type UnlockDetails, type UnlockResult } from "./types";

async function buyerBusinessId(personId: string, phone: string | null): Promise<string> {
  const m = await prisma.businessMember.findFirst({ where: { personId }, select: { businessId: true } });
  if (m) return m.businessId;
  // Phone-only buyers get a minimal buyer business; they can rename it later (progressive profiling).
  const { businessId } = await createBusiness(personId, { name: `Buyer ${phone ? phone.slice(-4) : personId.slice(0, 4)}`, isSeller: false });
  return businessId;
}

/**
 * Performs what the verified visitor asked for. Requires the capture to be verified for this person.
 * Never returns seller phone numbers: "contact seller" opens an in-app enquiry with that seller preferred and
 * contact details follow only the enquiry accept/consent rules (ADR-002).
 */
export async function completeUnlock(personId: string, captureId: string, detailsInput: UnlockDetails = {}): Promise<UnlockResult> {
  const capture = await getCapture(captureId);
  if (!capture || capture.personId !== personId) throw new DomainError("forbidden", "This request belongs to another account.");
  if (capture.status !== "verified" && capture.status !== "converted") throw new DomainError("forbidden", "Verify your mobile number first.");
  if (capture.status === "converted" && capture.enquiryId) {
    return { kind: "enquiry", enquiryId: capture.enquiryId, next: `/buyer/enquiries/${capture.enquiryId}` };
  }
  const details = unlockDetailsSchema.parse(detailsInput);
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { phone: true, phoneVerifiedAt: true, erasedAt: true } });
  if (!person || person.erasedAt || !person.phoneVerifiedAt) throw new DomainError("forbidden", "Verify your mobile number first.");

  if (capture.unlock === "quotes") {
    // The detailed RFQ form collects the specifics; verification is all this unlock grants.
    await markConverted(captureId, personId, null);
    return { kind: "quotes", next: capture.listingId ? `/rfq/new?listing=${capture.listingId}` : "/rfq/new" };
  }
  if (capture.unlock === "save" || capture.unlock === "catalogue") {
    await markConverted(captureId, personId, null);
    return { kind: "none", next: "/buyer/enquiries" };
  }

  const listing = capture.listingId
    ? await prisma.listing.findUnique({ where: { id: capture.listingId }, select: { title: true, category: { select: { slug: true } } } })
    : null;
  const label = listing?.title ?? "this product";
  const lead = capture.unlock === "seller_contact" ? "Contact request for" : "Best price for";
  const title = `${lead} ${label}`.slice(0, 140);
  const requirement =
    (details.message ? `${details.message}\n\n` : "") +
    `I am interested in ${label}. Please share your best price${details.quantity ? ` for ${details.quantity}${details.quantityUnit ? ` ${details.quantityUnit}` : ""}` : ""}.`;
  const enquiry = await createEnquiry(
    { personId, businessId: await buyerBusinessId(personId, person.phone) },
    {
      title, requirement: requirement.slice(0, 4000), categorySlug: listing?.category.slug ?? null,
      quantity: details.quantity ?? null, quantityUnit: details.quantityUnit ?? null,
      deliveryPincode: details.deliveryPincode ?? null, deliveryCity: details.deliveryCity ?? null,
      preferredListingId: capture.listingId,
    },
    { buyerPhoneVerified: true },
  );
  await markConverted(captureId, personId, enquiry.id);
  const next = `/buyer/enquiries/${enquiry.id}`;
  if (capture.unlock === "seller_contact") return { kind: "seller_contact", enquiryId: enquiry.id, next, contactRule: "in_app_after_match" };
  return { kind: "enquiry", enquiryId: enquiry.id, next };
}
