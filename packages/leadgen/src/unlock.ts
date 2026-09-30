import { getPublicListing } from "@cnote/catalogue";
import { DomainError, redis } from "@cnote/core";
import { createEnquiry } from "@cnote/enquiry";
import { createBusiness, getPersonBusinesses, getPersonVerification } from "@cnote/identity";
import { getCapture, markConverted } from "./capture";
import { unlockDetailsSchema, type UnlockDetails, type UnlockResult } from "./types";

async function buyerBusinessId(personId: string, phone: string | null): Promise<string> {
  const [first] = await getPersonBusinesses(personId);
  if (first) return first.businessId;
  // Phone-only buyers get a minimal buyer business; they can rename it later (progressive profiling).
  const { businessId } = await createBusiness(personId, { name: `Buyer ${phone ? phone.slice(-4) : personId.slice(0, 4)}`, isSeller: false });
  return businessId;
}

/**
 * Performs what the verified visitor asked for. Requires the capture to be verified for this person.
 * Never returns seller phone numbers: "contact seller" opens an in-app enquiry with that seller preferred and
 * contact details follow only the enquiry accept/consent rules (ADR-002).
 */
const CLAIM_TTL_SECONDS = 30;
/** How long a concurrent call waits for the in-flight unlock (≈4s). Mutable for tests only. */
export const UNLOCK_WAIT = { intervalMs: 100, attempts: 40 };
const claimKey = (captureId: string) => `leadgen:unlock:${captureId}`;

/**
 * Performs the unlock at most once per capture. A double-click / retry arriving while the first call is still
 * creating the enquiry waits for it and returns the same result instead of creating a second enquiry.
 */
export async function completeUnlock(personId: string, captureId: string, detailsInput: UnlockDetails = {}): Promise<UnlockResult> {
  const claimed = await redis.set(claimKey(captureId), personId, "EX", CLAIM_TTL_SECONDS, "NX");
  if (claimed === null) return awaitConcurrentUnlock(personId, captureId);
  try {
    return await performUnlock(personId, captureId, detailsInput);
  } finally {
    await redis.del(claimKey(captureId));
  }
}

async function awaitConcurrentUnlock(personId: string, captureId: string): Promise<UnlockResult> {
  for (let i = 0; i < UNLOCK_WAIT.attempts; i++) {
    await new Promise((r) => setTimeout(r, UNLOCK_WAIT.intervalMs));
    const c = await getCapture(captureId);
    if (c && c.personId === personId && c.status === "converted" && c.enquiryId) {
      return { kind: c.unlock === "seller_contact" ? "seller_contact" : "enquiry", enquiryId: c.enquiryId, next: `/buyer/enquiries/${c.enquiryId}`, ...(c.unlock === "seller_contact" ? { contactRule: "in_app_after_match" as const } : {}) } as UnlockResult;
    }
    if (!(await redis.exists(claimKey(captureId)))) return performUnlockOnce(personId, captureId);
  }
  throw new DomainError("conflict", "Your request is still being processed. Please refresh in a moment.", undefined, "leadgen.requestStillBeingProcessedRefresh");
}

async function performUnlockOnce(personId: string, captureId: string): Promise<UnlockResult> {
  const c = await getCapture(captureId);
  if (c?.status === "converted") return completeUnlock(personId, captureId);
  throw new DomainError("conflict", "Your request is still being processed. Please refresh in a moment.", undefined, "leadgen.requestStillBeingProcessedRefresh");
}

async function performUnlock(personId: string, captureId: string, detailsInput: UnlockDetails): Promise<UnlockResult> {
  const capture = await getCapture(captureId);
  if (!capture || capture.personId !== personId) throw new DomainError("forbidden", "This request belongs to another account.", undefined, "leadgen.requestBelongsAnotherAccount");
  if (capture.status !== "verified" && capture.status !== "converted") throw new DomainError("forbidden", "Verify your mobile number first.");
  if (capture.status === "converted" && capture.enquiryId) {
    return { kind: "enquiry", enquiryId: capture.enquiryId, next: `/buyer/enquiries/${capture.enquiryId}` };
  }
  const details = unlockDetailsSchema.parse(detailsInput);
  const person = await getPersonVerification(personId);
  if (!person || person.erased || !person.phoneVerified) throw new DomainError("forbidden", "Verify your mobile number first.");

  if (capture.unlock === "quotes") {
    // The detailed RFQ form collects the specifics; verification is all this unlock grants.
    await markConverted(captureId, personId, null);
    return { kind: "quotes", next: capture.listingId ? `/rfq/new?listing=${capture.listingId}` : "/rfq/new" };
  }
  if (capture.unlock === "save" || capture.unlock === "catalogue") {
    await markConverted(captureId, personId, null);
    return { kind: "none", next: "/buyer/enquiries" };
  }

  // Only live (published + approved) listings can be the subject of an unlock.
  const listing = capture.listingId ? await getPublicListing(capture.listingId) : null;
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
