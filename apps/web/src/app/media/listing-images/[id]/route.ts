import { readListingImage } from "@cnote/catalogue";

// Public product images. ONLY approved images on live listings are served (readListingImage
// enforces it); everything else is a 404 so pending/rejected uploads can't be probed.
export async function GET(req: Request, ctx: RouteContext<"/media/listing-images/[id]">) {
  const { id } = await ctx.params;
  const img = await readListingImage(id, { kind: "public" });
  if (!img) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const etag = `"${img.sha256}"`;
  const headers = {
    "Content-Type": img.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Buffer.from(img.bytes), { headers });
}
