// Recipient directory: turns ids from domain events into people and display data.
//
// TEMPORARY: identity, enquiry, reviews and catalogue expose no public lookups for this, so the
// default implementation below reads their tables directly (BusinessMember, Business, Person,
// Enquiry, Match, ProductReview, ProductComment, Listing). This is the ONLY file in
// @cnote/notifications that touches another module's models. Replace with public getters
// (e.g. identity.listBusinessMembers(businessId)) and delete the prisma reads. Everything else
// depends on the `Directory` interface, so tests inject a fake.
import { prisma } from "@cnote/db";

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
    const rows = await prisma.businessMember.findMany({
      where: { businessId, ...(opts?.ownersOnly ? { role: "owner" } : {}) },
      select: { personId: true },
    });
    return rows.map((r) => r.personId);
  },
  async businessName(businessId) {
    return (await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }))?.name ?? null;
  },
  async enquiry(enquiryId) {
    const e = await prisma.enquiry.findUnique({
      where: { id: enquiryId },
      select: { title: true, intentScore: true, buyerBusinessId: true, buyerPersonId: true },
    });
    return e;
  },
  async conversation(conversationId) {
    const c = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        match: {
          select: {
            sellerBusinessId: true,
            seller: { select: { name: true } },
            enquiry: { select: { id: true, title: true, buyerBusinessId: true } },
          },
        },
      },
    });
    if (!c) return null;
    const buyer = await prisma.business.findUnique({ where: { id: c.match.enquiry.buyerBusinessId }, select: { name: true } });
    return {
      enquiryId: c.match.enquiry.id,
      enquiryTitle: c.match.enquiry.title,
      buyerBusinessId: c.match.enquiry.buyerBusinessId,
      buyerName: buyer?.name ?? "The buyer",
      sellerBusinessId: c.match.sellerBusinessId,
      sellerName: c.match.seller.name,
    };
  },
  async listingTitle(listingId) {
    return (await prisma.listing.findUnique({ where: { id: listingId }, select: { title: true } }))?.title ?? null;
  },
  async review(reviewId) {
    return prisma.productReview.findUnique({ where: { id: reviewId }, select: { authorPersonId: true, moderationNote: true } });
  },
  async comment(commentId) {
    return prisma.productComment.findUnique({ where: { id: commentId }, select: { authorPersonId: true, moderationNote: true } });
  },
  async contact(personId) {
    const p = await prisma.person.findUnique({ where: { id: personId }, select: { email: true, phone: true, name: true, erasedAt: true } });
    if (!p || p.erasedAt) return null;
    return { email: p.email, phone: p.phone, name: p.name };
  },
};
