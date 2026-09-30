import { getSponsoredSlots, isAdsEnabled } from "@cnote/ads";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/paths";
import { isPublic, loadListing } from "@/features/search/data";
import { moqText } from "@/features/search/format";
import { VISITOR_COOKIE } from "@/features/ads/slots";

// Per-request and never cached: an ad decision is personal to the request (frequency cap, budget) and its click token expires.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("listingId") ?? "";
  if (!isAdsEnabled() || !isUuid(id)) return NextResponse.json({ items: [] }, { headers: noStore });
  try {
    const listing = await loadListing(id);
    if (!listing || !isPublic(listing)) return NextResponse.json({ items: [] }, { headers: noStore });
    const existing = req.cookies.get(VISITOR_COOKIE)?.value;
    const visitorId = existing ?? randomUUID();
    const slots = await getSponsoredSlots({
      query: listing.title,
      categoryId: listing.category.id,
      surface: "product_similar",
      organicListingIds: [listing.id],
      excludeSellerBusinessId: listing.sellerBusinessId,
      visitorId,
    });
    const res = NextResponse.json(
      {
        items: slots.map((s) => ({
          id: s.listing.id,
          title: s.listing.title,
          imageUrl: s.listing.imageUrls[0] ?? null,
          pricePaise: s.listing.pricePaise,
          priceUnit: s.listing.priceUnit,
          moqText: moqText(s.listing),
          seller: { name: s.seller.name, city: s.seller.city, tier: s.seller.verificationTier, badgeActive: s.seller.badgeActive },
          clickHref: s.clickHref,
        })),
      },
      { headers: noStore },
    );
    if (!existing) res.cookies.set(VISITOR_COOKIE, visitorId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 30, path: "/" });
    return res;
  } catch (err) {
    console.error("[web] /api/ads/similar failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ items: [] }, { headers: noStore });
  }
}
