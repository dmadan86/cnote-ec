import { NextResponse } from "next/server";
import { listApprovedReviews, type ReviewSort } from "@cnote/reviews";
import { isUuid } from "@/lib/paths";

const SORTS = new Set<ReviewSort>(["recent", "helpful", "rating_high", "rating_low"]);

/** Public, approved-only review pages for the sort / "more reviews" controls. CDN-cacheable (Redis tier behind it). */
export async function GET(req: Request, ctx: RouteContext<"/api/reviews/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const u = new URL(req.url);
  const sortParam = u.searchParams.get("sort") as ReviewSort | null;
  const sort: ReviewSort = sortParam && SORTS.has(sortParam) ? sortParam : "recent";
  const cursor = u.searchParams.get("cursor");
  try {
    const page = await listApprovedReviews(id, { sort, cursor });
    return NextResponse.json(page, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
