import { hasPrivilege } from "@cnote/admin";
import { getInvoicePdf } from "@cnote/billing";
import { errorResponse } from "@cnote/next-kit";
import { DomainError } from "@cnote/core";
import { actionContext } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Staff download of any invoice / credit note. Needs payments.read. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const c = await actionContext();
    if (!hasPrivilege(c.staff, "payments.read")) throw new DomainError("forbidden", "payments.read is required");
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError("not_found", "Invoice not found");
    const { bytes, filename } = await getInvoicePdf({ staff: true }, id);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
