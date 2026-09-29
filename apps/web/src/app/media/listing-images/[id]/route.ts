import { getListingImageDelivery } from "@cnote/catalogue";

// Public product images. ONLY approved images on live listings are served (the delivery gate enforces it);
// everything else is a 404 so pending/rejected uploads can't be probed. Remote drivers redirect (CDN URL of a
// processed derivative, else a short-lived signed URL); the local driver streams. Pages should use the variant
// URLs from ListingView/publicImagesForListing; this route is the stable fallback.
export async function GET(req: Request, ctx: RouteContext<"/media/listing-images/[id]">) {
  const { id } = await ctx.params;
  const d = await getListingImageDelivery(id, { kind: "public" });
  if (!d) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (d.kind === "redirect") return new Response(null, { status: 302, headers: { Location: d.url, "Cache-Control": d.cacheControl } });
  const etag = `"${d.sha256}"`;
  const headers = {
    "Content-Type": d.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Buffer.from(d.bytes), { headers });
}
