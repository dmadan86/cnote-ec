import { NextResponse } from "next/server";
import { getPublicListing } from "@cnote/catalogue";
import { currentSession } from "@cnote/next-kit";
import { listMyQuestions } from "@cnote/reviews";
import { isUuid } from "@/lib/paths";

/** Viewer-specific Q&A state for one product (own questions in every state, seller-side flag). Private, never cached. */
export async function GET(_req: Request, ctx: RouteContext<"/api/me/qa/[id]">) {
  const { id } = await ctx.params;
  const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  let session = null;
  try {
    session = await currentSession();
  } catch {
    /* signed out */
  }
  if (!session) return NextResponse.json({ signedIn: false, isSellerSide: false, mine: [] }, { headers });
  const [listing, mine] = await Promise.all([getPublicListing(id).catch(() => null), listMyQuestions(id, session.personId).catch(() => [])]);
  return NextResponse.json({ signedIn: true, isSellerSide: !!session.business && listing?.sellerBusinessId === session.business.id, mine }, { headers });
}
