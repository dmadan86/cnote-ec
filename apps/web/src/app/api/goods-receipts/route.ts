import { DomainError } from "@cnote/core";
import { MAX_GRN_PHOTOS, MAX_GRN_PHOTO_BYTES, recordGoodsReceipt, type ReceiptLineInput } from "@cnote/enquiry";
import { actorOf, currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";

// Record a goods receipt (GRN) with delivery / damage photos. Server actions are capped at 2 MB app-wide, so the multipart post lands here with its
// own cap (docs/design/grn-returns.md). Excluded from the proxy matcher (src/proxy.ts); the form refreshes an expired access token via /api/me.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business) throw new DomainError("forbidden", "Create your business profile first.");
    const form = await readBoundedFormData(req, MAX_GRN_PHOTOS * MAX_GRN_PHOTO_BYTES + 512 * 1024);
    const lines: ReceiptLineInput[] = [];
    for (const k of form.keys()) {
      const m = /^received__(\d{1,3})$/.exec(k);
      if (!m) continue;
      const no = Number(m[1]);
      const received = field(form, k);
      if (received === "" || Number(received) === 0) continue;
      const rejected = field(form, `rejected__${no}`);
      lines.push({
        poLineNo: no, receivedQty: Number(received), rejectedQty: rejected === "" ? 0 : Number(rejected),
        rejectReason: field(form, `reason__${no}`) || null, rejectNote: field(form, `note__${no}`) || null,
      });
    }
    const photos: { fileName: string; bytes: Uint8Array }[] = [];
    for (const v of form.getAll("photos")) {
      if (typeof v === "string" || v.size === 0) continue;
      photos.push({ fileName: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
    }
    const orderId = field(form, "orderId");
    const grn = await recordGoodsReceipt(actorOf(session as SessionWithBusiness), {
      purchaseOrderId: field(form, "purchaseOrderId"), receivedOn: field(form, "receivedOn"), receiverName: field(form, "receiverName"),
      deliveryNoteRef: field(form, "deliveryNoteRef") || null, note: field(form, "note") || null, lines, photos,
    });
    if (orderId) revalidatePath(`/buyer/orders/${orderId}`, "layout");
    revalidatePath("/buyer/payables");
    return Response.json({ ok: true, data: { id: grn.id, number: grn.number } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
