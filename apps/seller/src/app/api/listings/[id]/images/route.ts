import { errorResponse, currentSession } from "@cnote/next-kit";
import { DomainError } from "@cnote/core";
import { MAX_IMAGE_BYTES } from "@cnote/media";
import { catalogue } from "@/lib/services";

// Upload via a route handler (not a server action): server actions cap bodies at 1 MB by default and we
// may not change next.config. One file per request; the client sends them sequentially with progress.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: RouteContext<"/api/listings/[id]/images">) {
  try {
    const { id } = await ctx.params;
    const session = await currentSession();
    const business = session?.business;
    if (!business) throw new DomainError("unauthenticated", "Please sign in again");
    if (!business.isSeller) throw new DomainError("forbidden", "Seller account required");

    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES + 256 * 1024) throw new DomainError("validation", "Image is larger than 5 MB");
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) throw new DomainError("validation", "Expected a file upload");

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new DomainError("validation", "Choose an image to upload");
    if (file.size > MAX_IMAGE_BYTES) throw new DomainError("validation", "Image is larger than 5 MB");
    const alt = form.get("altText");
    const image = await catalogue.uploadListingImage(business.id, id, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      altText: typeof alt === "string" ? alt : undefined,
    });
    return Response.json({ ok: true, image }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
