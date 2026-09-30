// Injectable seams. Defaults call the public APIs of catalogue and identity; tests and the lead can override.
import { getPublicListing } from "@cnote/catalogue";
import { getBusinessBillingProfile, getPersonContact, getTrustProfiles, listBusinessMembers } from "@cnote/identity";

export interface ListingFacts {
  id: string;
  sellerBusinessId: string;
  title: string;
  categorySlug: string;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  /** published and moderation-approved (i.e. served from LIVE) */
  published: boolean;
}

export type ListingLookup = (listingId: string) => Promise<ListingFacts | null>;

const defaultListingLookup: ListingLookup = async (id) => {
  const l = await getPublicListing(id);
  return l ? { id: l.id, sellerBusinessId: l.sellerBusinessId, title: l.title, categorySlug: l.category.slug, pricePaise: l.pricePaise, priceUnit: l.priceUnit, moq: l.moq, published: true } : null;
};
let listingLookup: ListingLookup = defaultListingLookup;
/** Live listing facts (price, MOQ). Offers are validated against the LIVE listing, never the seller's working copy. */
export const getListingFacts: ListingLookup = (id) => listingLookup(id);
export const setListingLookup = (fn: ListingLookup | null) => void (listingLookup = fn ?? defaultListingLookup);

export interface RiskKeys {
  tier: number;
  name: string;
  personIds: string[];
  phones: string[];
  gstin: string | null;
}

export type GstinLookup = (businessId: string) => Promise<string | null>;
const defaultGstinLookup: GstinLookup = async (businessId) => (await getBusinessBillingProfile(businessId))?.gstin ?? null;
let gstinLookup: GstinLookup = defaultGstinLookup;
/** One-per-GSTIN coupon rule and GSTIN ring detection for referrals. Defaults to identity's billing profile; tests override. */
export const setGstinLookup = (fn: GstinLookup | null) => void (gstinLookup = fn ?? defaultGstinLookup);

export async function riskKeys(businessId: string): Promise<RiskKeys> {
  const [profiles, members, gstin] = await Promise.all([getTrustProfiles([businessId]), listBusinessMembers(businessId), gstinLookup(businessId)]);
  const p = profiles.get(businessId);
  const phones: string[] = [];
  for (const m of members) {
    const c = await getPersonContact(m.personId, { self: true });
    if (c?.phone) phones.push(c.phone);
  }
  return { tier: p?.verificationTier ?? 0, name: p?.name ?? "", personIds: members.map((m) => m.personId), phones, gstin };
}
