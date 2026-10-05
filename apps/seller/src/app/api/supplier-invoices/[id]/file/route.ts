import { currentSession } from "@cnote/next-kit";
import { enquiry } from "@/lib/services";

// The seller's own uploaded invoice copy (private bucket). Buyer or seller of the invoice only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function GET(_req: Request, ctx: RouteContext<"/api/supplier-invoices/[id]/file">) {
  const { id } = await ctx.params;
  const s = await currentSession();
  if (!s?.business) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  const a = await enquiry.openSupplierInvoiceFile({ personId: s.personId, businessId: s.business.id }, id);
  if (!a) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (a.signedUrl) return new Response(null, { status: 302, headers: { Location: a.signedUrl, ...NO_STORE } });
  return new Response(Buffer.from(a.bytes!), {
    headers: { "Content-Type": a.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`, "X-Content-Type-Options": "nosniff", ...NO_STORE },
  });
}
