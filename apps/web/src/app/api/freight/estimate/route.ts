import { DomainError } from "@cnote/core";
import { estimateForListing } from "@cnote/logistics";
import { NextResponse, type NextRequest } from "next/server";
import { fail, limited } from "@/features/search/api-guard";
import { isUuid } from "@/lib/paths";

// Freight ESTIMATE for a public listing (docs/design/freight-estimator.md). Public product facts + a PIN the visitor typed:
// nothing personal is stored. Per-IP rate limited (fails closed: live carrier calls cost money). Final freight is quoted by the seller.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, max-age=120", "X-Robots-Tag": "noindex" } as const;

/** GET /api/freight/estimate?listingId=<uuid>&quantity=<n>&pincode=<6 digits> */
export async function GET(req: NextRequest) {
  const blocked = await limited(req, "freight", 30, 60);
  if (blocked) return blocked;
  const sp = req.nextUrl.searchParams;
  const listingId = sp.get("listingId") ?? "";
  const quantity = Number(sp.get("quantity"));
  const pincode = (sp.get("pincode") ?? "").trim();
  if (!isUuid(listingId)) return fail(404, "not_found");
  if (!/^[1-9]\d{5}$/.test(pincode)) return fail(400, "invalid_pincode");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000_000) return fail(400, "invalid_quantity");
  try {
    return NextResponse.json(await estimateForListing(listingId, quantity, pincode), { headers: HEADERS });
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code === "not_found" ? 404 : 400, err.code);
    console.error("[web] /api/freight/estimate failed:", err instanceof Error ? err.message : err);
    return fail(503, "unavailable");
  }
}
