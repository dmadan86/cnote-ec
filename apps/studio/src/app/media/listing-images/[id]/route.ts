import { readListingImage } from "@cnote/catalogue";
import { currentSession } from "@cnote/next-kit";

/**
 * Listing images for the editor and token previews. Approved images are public anyway (the buyer site serves the same
 * bytes); the signed-in seller additionally sees their own pending images while editing. Anything else is a 404.
 */
export async function GET(_req: Request, ctx: RouteContext<"/media/listing-images/[id]">) {
  const { id } = await ctx.params;
  let img = await readListingImage(id, { kind: "public" }).catch(() => null);
  if (!img) {
    const session = await currentSession().catch(() => null);
    const biz = session?.business?.id;
    if (biz) img = await readListingImage(id, { kind: "seller", sellerBusinessId: biz }).catch(() => null);
  }
  if (!img) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(Buffer.from(img.bytes), {
    headers: {
      "Content-Type": img.contentType,
      "Cache-Control": img.status === "approved" ? "private, max-age=300" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
