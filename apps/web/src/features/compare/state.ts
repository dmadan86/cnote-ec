import "server-only";
import { getListingsByIds, type ListingView } from "@cnote/catalogue";
import { COMPARE_COOKIE, parseCompareIds } from "@cnote/wishlist";
import { cookies } from "next/headers";
import { cache } from "react";

/** Listing ids in the compare tray (cookie), validated and capped. */
export const readCompareIds = cache(async (): Promise<string[]> => parseCompareIds((await cookies()).get(COMPARE_COOKIE)?.value));

export const isPublicListing = (l: ListingView) => l.status === "published" && l.moderationStatus === "approved";

/** Public listings for the given ids, in order. Fails soft. */
export async function loadCompareListings(ids: string[]): Promise<ListingView[]> {
  if (!ids.length) return [];
  try {
    return (await getListingsByIds(ids)).filter(isPublicListing);
  } catch (err) {
    console.error("[web] compare.loadCompareListings failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
