import "server-only";
import { attributeEnquiry, getSponsoredSlots, isAdsEnabled, type SponsoredSlot } from "@cnote/ads";
import { cookies } from "next/headers";
import { safe } from "@/features/search/data";

export const VISITOR_COOKIE = "cnote_vid";
export const AD_CLICK_COOKIE = "cnote_ad_click";

/** Slots for a results page, or [] (ads off, kill switch, any failure). Never throws: organic results must always render. */
export async function loadSponsoredForResults(o: { query: string; categoryId?: string | null; surface: "search" | "category"; organicListingIds: string[] }): Promise<SponsoredSlot[]> {
  if (!isAdsEnabled()) return [];
  return safe("ads.getSponsoredSlots", async () => {
    const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
    return getSponsoredSlots({ ...o, visitorId });
  }, [] as SponsoredSlot[]);
}

/** Exact ad attribution from the click cookie, right after an enquiry is created. Fail-soft and idempotent per enquiry. */
export async function attributeEnquiryFromCookie(i: { enquiryId: string; buyerBusinessId: string; listingId?: string | null }): Promise<void> {
  if (!isAdsEnabled()) return;
  const clickId = (await cookies()).get(AD_CLICK_COOKIE)?.value;
  if (!clickId) return;
  await safe("ads.attributeEnquiry", async () => void (await attributeEnquiry({ ...i, clickId })), undefined);
}
