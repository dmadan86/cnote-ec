import { isFollowing } from "@cnote/alerts";
import { currentSession } from "@cnote/next-kit";
import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/paths";

// Follow state for the static supplier profile / seller card (docs/design/buyer-retention.md). Private and uncached: the page HTML
// never carries per-person state; the FollowIsland asks this once the shared per-user state says the visitor is signed in.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Robots-Tag": "noindex" } as const;

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/follow/[businessId]">) {
  const { businessId } = await ctx.params;
  if (!isUuid(businessId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const session = await currentSession().catch(() => null);
  if (!session) return NextResponse.json({ following: false, signedIn: false }, { headers: NO_STORE });
  try {
    return NextResponse.json({ following: await isFollowing(session.personId, businessId), signedIn: true }, { headers: NO_STORE });
  } catch (err) {
    console.error("[web] /api/follow failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
