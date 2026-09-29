import { DomainError } from "@cnote/core";
import { getDownload } from "@cnote/bulk";
import { errorResponse } from "@cnote/next-kit";
import { bulkActor } from "@/features/bulk/route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?which=result|errors|source. Seller-scoped; redirects to a short-lived signed URL when the store can sign. */
export async function GET(req: Request, ctx: RouteContext<"/api/bulk/jobs/[id]/download">) {
  try {
    const { id } = await ctx.params;
    const which = new URL(req.url).searchParams.get("which") ?? "result";
    if (which !== "result" && which !== "errors" && which !== "source") throw new DomainError("validation", "Unknown download");
    const dl = await getDownload(await bulkActor(), id, which, { preferSignedUrl: true });
    if (dl.url) return Response.redirect(dl.url, 302);
    const name = dl.filename.replace(/[^\w.\- ]+/g, "_");
    return new Response(Buffer.from(dl.bytes!), {
      headers: {
        "Content-Type": dl.contentType,
        "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(dl.filename)}`,
        "Content-Length": String(dl.bytes!.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
