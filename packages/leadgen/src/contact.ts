// Supplier contact options for a buyer who has legitimately unlocked the supplier.
//
// "Unlocked" means: the buyer has an enquiry for which THIS supplier's match was ACCEPTED. The supplier accepting spends
// one of their lead credits (ADR-005), which is what opens the contact (ADR-002); `completeUnlock` alone only creates
// the enquiry and never returns a number. The details come from the owning module (identity.getPersonContact), which
// already honours the supplier's `counterparty_sharing` consent (their contact preference): without it neither the phone
// nor the email is returned and the buyer keeps the in-app conversation.
import { getPublicListing } from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { listBuyerEnquiries } from "@cnote/enquiry";
import { getPersonBusinesses, getPersonContact, hasConsent, listBusinessMembers } from "@cnote/identity";

export const CONTACT_CHANNELS = ["call", "whatsapp", "email", "enquiry"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export type SupplierContact =
  | { unlocked: false }
  | {
      unlocked: true;
      sellerBusinessId: string;
      sellerName: string;
      enquiryId: string;
      conversationId: string | null;
      /** E.164, e.g. +919876543210; null when the supplier has not agreed to share it. */
      phone: string | null;
      /** wa.me form: E.164 digits without "+"; null with no phone. */
      whatsapp: string | null;
      email: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;

/** The buyer's accepted match with the listing's supplier, newest enquiry first. */
async function acceptedMatch(personId: string, sellerBusinessId: string) {
  const businesses = await getPersonBusinesses(personId);
  let best: { enquiryId: string; conversationId: string | null; sellerName: string } | null = null;
  for (const b of businesses) {
    for (const e of await listBuyerEnquiries(b.businessId)) {
      const m = e.matches.find((x) => x.sellerBusinessId === sellerBusinessId && x.status === "accepted");
      if (m) {
        best = { enquiryId: e.id, conversationId: m.conversationId, sellerName: m.sellerName };
        break; // listBuyerEnquiries is newest first
      }
    }
    if (best) break;
  }
  return best;
}

/**
 * Contact options for the supplier of `listingId`, only when `personId` has unlocked them. Never cacheable: callers must
 * answer `Cache-Control: private, no-store`. Locked, unknown listings and erased suppliers all answer `{ unlocked: false }`.
 */
export async function getUnlockedSupplierContact(personId: string, listingId: string): Promise<SupplierContact> {
  if (!UUID.test(listingId)) return { unlocked: false };
  const listing = await getPublicListing(listingId);
  if (!listing) return { unlocked: false };
  const match = await acceptedMatch(personId, listing.sellerBusinessId);
  if (!match) return { unlocked: false };

  let phone: string | null = null;
  let email: string | null = null;
  for (const owner of await listBusinessMembers(listing.sellerBusinessId, { ownersOnly: true })) {
    // getPersonContact omits the phone without consent; the email is not gated there, so gate it here as well.
    if (!(await hasConsent(owner.personId, "counterparty_sharing"))) continue;
    const c = await getPersonContact(owner.personId);
    if (!c) continue;
    phone = c.phone && E164.test(c.phone) ? c.phone : null;
    email = c.email;
    if (phone || email) break;
  }
  return {
    unlocked: true,
    sellerBusinessId: listing.sellerBusinessId,
    sellerName: match.sellerName,
    enquiryId: match.enquiryId,
    conversationId: match.conversationId,
    phone,
    whatsapp: phone ? phone.slice(1) : null,
    email,
  };
}

/**
 * Logs that the buyer used a contact channel (metrics: SupplierContacted v1). Re-checks the unlock server-side, so the
 * client cannot log contacts it never earned. The event carries ids and the channel, never the number or address.
 */
export async function recordSupplierContacted(personId: string, listingId: string, channel: ContactChannel): Promise<void> {
  if (!CONTACT_CHANNELS.includes(channel)) throw new DomainError("validation", "Unknown contact channel");
  let allowed = true;
  try {
    allowed = await rateLimit(`leadgen:contacted:${personId}`, 30, 60);
  } catch {
    /* Redis unavailable: fail open, this only guards a metrics log */
  }
  if (!allowed) throw new DomainError("rate_limited", "Too many requests. Please wait a minute.");
  const contact = await getUnlockedSupplierContact(personId, listingId);
  if (!contact.unlocked) throw new DomainError("forbidden", "Contact this supplier first.");
  await prisma.$transaction(async (tx) => {
    await emit(tx, "SupplierContacted", { type: "Enquiry", id: contact.enquiryId }, {
      buyerPersonId: personId, sellerBusinessId: contact.sellerBusinessId, listingId, enquiryId: contact.enquiryId, channel,
    });
  });
}
