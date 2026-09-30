import { DomainError } from "@cnote/core";
import { errorResponse } from "@cnote/next-kit";
import { submitDispatchPhotos } from "@cnote/quality";
import { revalidatePath } from "next/cache";
import { assertDeclaredSize, sellerActor } from "@/features/ai-draft/route-auth";

// Multipart upload of 1-4 pre-dispatch photos (ADR-015). Advisory analysis runs asynchronously in the worker.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 21 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const actor = await sellerActor(req);
    const { orderId } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new DomainError("not_found", "Order not found");
    assertDeclaredSize(req, MAX_BODY, "Photos are larger than 20 MB in total");
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
    if (files.length < 1 || files.length > 4) throw new DomainError("validation", "Add 1 to 4 photos");
    const check = await submitDispatchPhotos(actor, orderId, await Promise.all(files.map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), filename: f.name }))));
    revalidatePath(`/orders/${orderId}`);
    return Response.json({ ok: true, checkId: check.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
