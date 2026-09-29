import * as enquiry from "@cnote/enquiry";

/**
 * "Verified enquiry" badge: the reviewer had an accepted lead with this seller (ADR-003).
 * TODO(enquiry): needs `enquiry.hasAcceptedMatch(buyerBusinessId, sellerBusinessId)`. Until the
 * enquiry module exports it this is false; once it does, this starts returning it with no change here.
 */
export async function hasVerifiedEnquiry(buyerBusinessId: string | null, sellerBusinessId: string): Promise<boolean> {
  if (!buyerBusinessId) return false;
  try {
    const fn = (enquiry as unknown as { hasAcceptedMatch?: (buyer: string, seller: string) => Promise<boolean> }).hasAcceptedMatch;
    return typeof fn === "function" ? await fn(buyerBusinessId, sellerBusinessId) : false;
  } catch {
    return false;
  }
}
