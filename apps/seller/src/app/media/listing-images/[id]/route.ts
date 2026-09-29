import { currentSession } from "@cnote/next-kit";
import { catalogue } from "@/lib/services";

/**
 * Seller's own images, any moderation status (they must see pending/rejected ones). Session-gated;
 * never cached shared. Approved images may be cached privately for a short time; everything else is no-store.
 */
export async function GET(_req: Request, ctx: RouteContext<"/media/listing-images/[id]">) {
  const { id } = await ctx.params;
  const session = await currentSession();
  const businessId = session?.business?.id;
  if (!businessId) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  const img = await catalogue.getListingImageDelivery(id, { kind: "seller", sellerBusinessId: businessId });
  if (!img) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  // Remote drivers: 5-minute signed URL of the private original, never cached (the redirect itself carries no secret beyond the ttl).
  if (img.kind === "redirect") return new Response(null, { status: 302, headers: { Location: img.url, "Cache-Control": "private, no-store" } });
  return new Response(Buffer.from(img.bytes), {
    headers: {
      "Content-Type": img.contentType,
      "Cache-Control": img.status === "approved" ? "private, max-age=300" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
