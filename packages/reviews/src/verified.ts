import { hasAcceptedMatch } from "@cnote/enquiry";

/**
 * "Verified enquiry" badge: the reviewer had an accepted lead with this seller (ADR-003).
 * Delegates to the enquiry module's public getter; fails closed (false) on any lookup error.
 */
export async function hasVerifiedEnquiry(buyerBusinessId: string | null, sellerBusinessId: string): Promise<boolean> {
  if (!buyerBusinessId) return false;
  try {
    return await hasAcceptedMatch(buyerBusinessId, sellerBusinessId);
  } catch {
    return false;
  }
}
