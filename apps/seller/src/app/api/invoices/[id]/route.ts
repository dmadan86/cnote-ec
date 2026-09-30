import { DomainError } from "@cnote/core";
import { getInvoicePdf } from "@cnote/billing";
import { currentSession } from "@cnote/next-kit";
import { errorResponse } from "@cnote/next-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the signed-in business's own tax invoice / credit note as a PDF. Anyone else gets 404. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await currentSession();
    if (!session?.business) throw new DomainError("unauthenticated", "Please sign in again");
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError("not_found", "Invoice not found");
    const { bytes, filename } = await getInvoicePdf({ businessId: session.business.id }, id);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
