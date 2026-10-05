import { currentSession, errorResponse } from "@cnote/next-kit";
import { enquiry } from "@/lib/services";

// The stored PDF of one purchase-order version, for the seller it is addressed to. Never cacheable or indexable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function GET(req: Request, ctx: RouteContext<"/api/purchase-orders/[id]/pdf">) {
  try {
    const { id } = await ctx.params;
    const s = await currentSession();
    if (!s?.business) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
    const v = Number(new URL(req.url).searchParams.get("v"));
    const pdf = await enquiry.getPurchaseOrderPdf({ personId: s.personId, businessId: s.business.id }, id, Number.isInteger(v) && v > 0 ? v : undefined);
    return new Response(Buffer.from(pdf.bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${pdf.filename}"`, "X-Content-Type-Options": "nosniff", ...NO_STORE },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
