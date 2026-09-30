import { hasPrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { errorResponse } from "@cnote/next-kit";
import { readQualityMedia } from "@cnote/quality";
import { actionContext } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: a private dispatch photo for staff holding quality.review (labelling). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { staff } = await actionContext();
    if (!hasPrivilege(staff, "quality.review")) throw new DomainError("forbidden", "Not allowed");
    const { id } = await ctx.params;
    const m = await readQualityMedia(id, { staff: true });
    if (!m) throw new DomainError("not_found", "Photo not found");
    return new Response(new Uint8Array(m.bytes), { headers: { "Content-Type": m.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    return errorResponse(err);
  }
}
