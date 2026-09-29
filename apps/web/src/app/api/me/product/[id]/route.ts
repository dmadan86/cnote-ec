import { NextResponse } from "next/server";
import { getPublicListing } from "@cnote/catalogue";
import { currentSession } from "@cnote/next-kit";
import { getMyReview, listMyPendingComments } from "@cnote/reviews";
import { isUuid } from "@/lib/paths";

/** Viewer-specific review state for one product (own review, own pending questions, seller-side flag). Private. */
export async function GET(_req: Request, ctx: RouteContext<"/api/me/product/[id]">) {
  const { id } = await ctx.params;
  const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  let session = null;
  try {
    session = await currentSession();
  } catch {
    /* signed out */
  }
  if (!session) return NextResponse.json({ signedIn: false, isSellerSide: false, mine: null, myComments: [] }, { headers });
  const [listing, mine, myComments] = await Promise.all([
    getPublicListing(id).catch(() => null),
    getMyReview(id, session.personId).catch(() => null),
    listMyPendingComments(id, session.personId).catch(() => []),
  ]);
  return NextResponse.json({ signedIn: true, isSellerSide: !!session.business && listing?.sellerBusinessId === session.business.id, mine, myComments }, { headers });
}
