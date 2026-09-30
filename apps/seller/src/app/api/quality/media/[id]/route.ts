import { DomainError } from "@cnote/core";
import { currentSession, errorResponse } from "@cnote/next-kit";
import { readQualityMedia } from "@cnote/quality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the signed-in seller's own dispatch photo from the private bucket. Anyone else gets 404. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await currentSession();
    if (!session?.business?.isSeller) throw new DomainError("unauthenticated", "Please sign in again");
    const { id } = await ctx.params;
    const m = await readQualityMedia(id, { sellerBusinessId: session.business.id });
    if (!m) throw new DomainError("not_found", "Photo not found");
    return new Response(new Uint8Array(m.bytes), { headers: { "Content-Type": m.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    return errorResponse(err);
  }
}
