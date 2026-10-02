import { getPublicListingsByIds } from "@cnote/catalogue";
import { NextResponse, type NextRequest } from "next/server";
import { limited } from "@/features/search/api-guard";
import { productPath } from "@/lib/paths";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 12;
// The ids come from the visitor's own device and are not stored. Public product facts only, so nothing personal is
// returned; `private` keeps the (history-bearing) URL out of shared caches.
const HEADERS = { "Cache-Control": "private, max-age=60", "X-Robots-Tag": "noindex" };

/** GET /api/recently-viewed?ids=<uuid>,<uuid>… -> public facts for the rail, in the order asked (live listings only). */
export async function GET(req: NextRequest) {
  const blocked = await limited(req, "recent", 60, 60);
  if (blocked) return blocked;
  const ids = [...new Set((req.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)))].slice(0, MAX);
  if (!ids.length) return NextResponse.json({ items: [] }, { headers: HEADERS });
  const listings = await getPublicListingsByIds(ids).catch(() => []);
  const byId = new Map(listings.map((l) => [l.id.toLowerCase(), l]));
  const items = ids.flatMap((id) => {
    const l = byId.get(id);
    return l
      ? [{ id: l.id, href: productPath(l), title: l.title, image: l.imageUrls[0] ?? null, blur: l.imageBlurs?.[0] ?? null, pricePaise: l.pricePaise, unit: l.priceUnit }]
      : [];
  });
  return NextResponse.json({ items }, { headers: HEADERS });
}
