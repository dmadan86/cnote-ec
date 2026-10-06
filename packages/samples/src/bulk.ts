// From an approved sample to the bulk order: RFQ pre-fill, linking the RFQ (or accepting the linked quote), and the "golden sample"
// quality reference shown on later order/PO pages.
import { DomainError, emit } from "@cnote/core";
import { getPublicListing } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { decideQuote, getBuyerEnquiry, getOrder } from "@cnote/enquiry";
import { getTrustProfiles } from "@cnote/identity";
import { UUID, loadForParty, lockSample, requireEnabled, status, viewOf } from "./internal";
import type { Actor, BulkPrefill, GoldenSampleView, SampleView } from "./types";

async function approvedForBuyer(actor: Actor, id: string) {
  const { r, role } = await loadForParty(actor, id);
  if (role !== "buyer") throw new DomainError("forbidden", "Only the buyer can ask for a bulk quote.");
  if (status(r) !== "approved") throw new DomainError("conflict", "Approve the sample first: a bulk quote refers to an approved sample.");
  return r;
}

/**
 * What the RFQ form needs to start a bulk request from an approved sample. The sample id travels with the form; after the
 * RFQ is created the caller links it with linkBulkEnquiry().
 */
export async function getBulkPrefill(actor: Actor, id: string): Promise<BulkPrefill> {
  requireEnabled();
  const r = await approvedForBuyer(actor, id);
  const profiles = await getTrustProfiles([r.sellerBusinessId]);
  const listing = r.listingId ? await getPublicListing(r.listingId).catch(() => null) : null;
  return {
    sampleId: r.id, subject: r.subject, sellerBusinessId: r.sellerBusinessId, sellerName: profiles.get(r.sellerBusinessId)?.name ?? "Seller",
    listingId: r.listingId, categorySlug: listing?.category.slug ?? null, quantityUnit: r.unit, quoteId: r.quoteId,
    requirementNote: `Quality reference: the sample I approved on ${r.evaluatedAt?.toISOString().slice(0, 10) ?? "an earlier date"} (sample ${r.id.slice(0, 8)}). Bulk supply must match it.`,
  };
}

/** Records that `enquiryId` (the buyer's own RFQ) was raised from this approved sample. Idempotent for the same RFQ. */
export async function linkBulkEnquiry(actor: Actor, id: string, enquiryId: string): Promise<SampleView> {
  requireEnabled();
  const r = await approvedForBuyer(actor, id);
  if (!UUID.test(enquiryId) || !(await getBuyerEnquiry(actor.businessId, enquiryId))) throw new DomainError("not_found", "Requirement not found");
  if (r.bulkEnquiryId === enquiryId) return viewOf(id, actor);
  if (r.bulkEnquiryId) throw new DomainError("conflict", "A bulk request is already linked to this sample.");
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const cur = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    if (cur.bulkEnquiryId) return;
    await tx.sampleRequest.update({ where: { id }, data: { bulkEnquiryId: enquiryId, bulkRequestedAt: new Date() } });
    await emit(tx, "SampleBulkQuoteRequested", { type: "sample", id }, { sampleId: id, buyerBusinessId: cur.buyerBusinessId, sellerBusinessId: cur.sellerBusinessId, enquiryId });
  });
  return viewOf(id, actor);
}

/**
 * The sample was requested against a seller's quote: accept that quote (creating the order, ADR-007) with the approved sample
 * as the golden reference. The enquiry module records the deal; the sample is linked to the same requirement.
 */
export async function acceptLinkedQuote(actor: Actor, id: string): Promise<SampleView> {
  requireEnabled();
  const r = await approvedForBuyer(actor, id);
  if (!r.quoteId) throw new DomainError("conflict", "This sample is not linked to a quote. Request a bulk quote instead.");
  if (r.bulkRequestedAt) return viewOf(id, actor);
  await decideQuote(actor, r.quoteId, "accept");
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const cur = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    if (cur.bulkRequestedAt) return;
    await tx.sampleRequest.update({ where: { id }, data: { bulkRequestedAt: new Date(), ...(cur.enquiryId && !cur.bulkEnquiryId ? { bulkEnquiryId: cur.enquiryId } : {}) } });
    if (cur.enquiryId) {
      await emit(tx, "SampleBulkQuoteRequested", { type: "sample", id }, { sampleId: id, buyerBusinessId: cur.buyerBusinessId, sellerBusinessId: cur.sellerBusinessId, enquiryId: cur.enquiryId });
    }
  });
  return viewOf(id, actor);
}

/**
 * The approved sample behind an order, for the order/PO page of either party. Matches on the quote the order came from, on the
 * RFQ raised from the sample, or on a sample requested inside that requirement's conversation, always between the same two businesses.
 */
export async function getGoldenSampleForOrder(actor: Actor, orderId: string): Promise<GoldenSampleView | null> {
  if (!UUID.test(orderId)) return null;
  const order = await getOrder(actor, orderId);
  if (!order) return null; // not a party to the order
  const buyerBusinessId = order.role === "buyer" ? actor.businessId : order.counterparty.businessId;
  const sellerBusinessId = order.role === "seller" ? actor.businessId : order.counterparty.businessId;
  const links = [
    ...(order.quoteId ? [{ quoteId: order.quoteId }] : []),
    ...(order.enquiryId ? [{ bulkEnquiryId: order.enquiryId }, { enquiryId: order.enquiryId }] : []),
  ];
  if (links.length === 0) return null;
  const s = await prisma.sampleRequest.findFirst({
    where: { buyerBusinessId, sellerBusinessId, status: "approved", OR: links },
    orderBy: { evaluatedAt: "desc" },
    include: { media: { where: { purgedAt: null }, orderBy: { createdAt: "asc" } } },
  });
  if (!s || !s.evaluatedAt) return null;
  return {
    id: s.id, subject: s.subject, quantity: s.quantity, unit: s.unit, approvedAt: s.evaluatedAt.toISOString(),
    notes: s.personalDataPurgedAt ? null : s.evaluationNotes, photos: s.media.map((m) => ({ id: m.id })), role: order.role,
  };
}
