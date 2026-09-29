// Recipient directory: turns ids from domain events into people and display data, using only the
// owning modules' public getters (identity, enquiry, reviews, catalogue). Tests inject a fake `Directory`.
import { getListingTitles } from "@cnote/catalogue";
import { getConversationParties, getEnquirySummary } from "@cnote/enquiry";
import { getPersonContact, getTrustProfiles, listBusinessMembers } from "@cnote/identity";
import { getCommentAuthor, getReviewAuthor } from "@cnote/reviews";

export interface EnquiryInfo {
  title: string;
  intentScore: number | null;
  buyerBusinessId: string;
  buyerPersonId: string;
}
export interface ConversationInfo {
  enquiryId: string;
  enquiryTitle: string;
  buyerBusinessId: string;
  buyerName: string;
  sellerBusinessId: string;
  sellerName: string;
}
export interface Contact {
  email: string | null;
  phone: string | null;
  name: string | null;
}

export interface Directory {
  /** person ids of a business's members; `ownersOnly` narrows to role=owner */
  businessMembers(businessId: string, opts?: { ownersOnly?: boolean }): Promise<string[]>;
  businessName(businessId: string): Promise<string | null>;
  enquiry(enquiryId: string): Promise<EnquiryInfo | null>;
  conversation(conversationId: string): Promise<ConversationInfo | null>;
  listingTitle(listingId: string): Promise<string | null>;
  review(reviewId: string): Promise<{ authorPersonId: string; moderationNote: string | null } | null>;
  comment(commentId: string): Promise<{ authorPersonId: string; moderationNote: string | null } | null>;
  /** null when the person is unknown or erased (DPDP) */
  contact(personId: string): Promise<Contact | null>;
}

export const prismaDirectory: Directory = {
  async businessMembers(businessId, opts) {
    return (await listBusinessMembers(businessId, opts)).map((r) => r.personId);
  },
  async businessName(businessId) {
    return (await getTrustProfiles([businessId])).get(businessId)?.name ?? null;
  },
  async enquiry(enquiryId) {
    const e = await getEnquirySummary(enquiryId);
    return e ? { title: e.title, intentScore: e.intentScore, buyerBusinessId: e.buyerBusinessId, buyerPersonId: e.buyerPersonId } : null;
  },
  async conversation(conversationId) {
    return getConversationParties(conversationId);
  },
  async listingTitle(listingId) {
    return (await getListingTitles([listingId])).get(listingId) ?? null;
  },
  async review(reviewId) {
    return getReviewAuthor(reviewId);
  },
  async comment(commentId) {
    return getCommentAuthor(commentId);
  },
  async contact(personId) {
    return getPersonContact(personId, { self: true }); // notifications go to the person themselves
  },
};
