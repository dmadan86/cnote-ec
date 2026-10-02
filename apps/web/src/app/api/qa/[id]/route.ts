import { NextResponse, type NextRequest } from "next/server";
import { listPublicQuestions } from "@cnote/reviews";
import { limited } from "@/features/search/api-guard";
import { isUuid } from "@/lib/paths";

/**
 * Public, approved-only answered questions for the Q&A section's "show more" and search. Pages without a search are
 * CDN-cacheable (Redis tier behind them, purged by `qa:<id>`); searches are per-IP rate limited and never cached.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/qa/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const u = new URL(req.url);
  const q = u.searchParams.get("q");
  const cursor = u.searchParams.get("cursor");
  if (q) {
    const blocked = await limited(req, "qa-search", 30, 60);
    if (blocked) return blocked;
  }
  try {
    const page = await listPublicQuestions(id, { q, cursor });
    return NextResponse.json(page, { headers: { "Cache-Control": q ? "private, no-store" : "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
