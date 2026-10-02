import { currentSession } from "@cnote/next-kit";
import { enquiry } from "@/lib/services";

// Private RFQ drawings/specs on a lead the seller holds, and the seller's own quote attachments (ADR-010).
// Authorised per request; remote drivers answer with a 5-minute signed URL, the local driver streams.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function GET(_req: Request, ctx: RouteContext<"/api/rfq-attachments/[id]">) {
  const { id } = await ctx.params;
  const s = await currentSession();
  if (!s?.business) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  const a = await enquiry.openAttachment({ personId: s.personId, businessId: s.business.id }, id);
  if (!a) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (a.signedUrl) return new Response(null, { status: 302, headers: { Location: a.signedUrl, ...NO_STORE } });
  return new Response(Buffer.from(a.bytes!), {
    headers: {
      "Content-Type": a.mimeType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      ...NO_STORE,
    },
  });
}
