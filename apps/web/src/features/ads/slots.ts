import "server-only";
import { attributeEnquiry, getSponsoredSlots, isAdsEnabled, type SponsoredSlot } from "@cnote/ads";
import { cookies } from "next/headers";
import { safe } from "@/features/search/data";
import { buyerLocation } from "@/features/search/geo";
import { CONSENT_COOKIE, isGranted, parseConsent } from "@/features/consent/state";
import { PINCODE_COOKIE } from "@/features/shell/site";

export const VISITOR_COOKIE = "cnote_vid";
export const AD_CLICK_COOKIE = "cnote_ad_click";

/** Slots for a results page, or [] (ads off, kill switch, any failure). Never throws: organic results must always render. */
export async function loadSponsoredForResults(o: { query: string; categoryId?: string | null; surface: "search" | "category"; organicListingIds: string[] }): Promise<SponsoredSlot[]> {
  if (!isAdsEnabled()) return [];
  return safe("ads.getSponsoredSlots", async () => {
    const jar = await cookies();
    // marketing storage: only read with the visitor's marketing consent
    const visitorId = isGranted(parseConsent(jar.get(CONSENT_COOKIE)?.value), "marketing") ? (jar.get(VISITOR_COOKIE)?.value ?? null) : null;
    // "Deliver to" pincode -> geo-targeted campaigns (ads geoOk); unknown location matches only unrestricted campaigns
    return getSponsoredSlots({ ...o, visitorId, ...buyerLocation(jar.get(PINCODE_COOKIE)?.value) });
  }, [] as SponsoredSlot[]);
}

/** Exact ad attribution from the click cookie, right after an enquiry is created. Fail-soft and idempotent per enquiry. */
export async function attributeEnquiryFromCookie(i: { enquiryId: string; buyerBusinessId: string; listingId?: string | null }): Promise<void> {
  if (!isAdsEnabled()) return;
  const jar = await cookies();
  if (!isGranted(parseConsent(jar.get(CONSENT_COOKIE)?.value), "marketing")) return;
  const clickId = jar.get(AD_CLICK_COOKIE)?.value;
  if (!clickId) return;
  await safe("ads.attributeEnquiry", async () => void (await attributeEnquiry({ ...i, clickId })), undefined);
}
