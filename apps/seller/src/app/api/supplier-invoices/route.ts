import { DomainError } from "@cnote/core";
import { actorOf, currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { numOrNull, str } from "@/lib/form-data";
import { enquiry } from "@/lib/services";
import { revalidatePath } from "next/cache";

// Record a supplier invoice against a purchase order, optionally with a copy (PDF/JPG/PNG up to 5 MB). Server actions are capped at 2 MB
// app-wide, so the multipart post lands here with its own cap (docs/design/purchase-orders.md).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rupeesToPaise = (v: number | null): number => (v === null || !Number.isFinite(v) || v < 0 ? -1 : Math.round(v * 100));

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business?.isSeller) throw new DomainError("forbidden", "Seller account required");
    const form = await readBoundedFormData(req, enquiry.MAX_INVOICE_FILE_BYTES + 512 * 1024);
    const file = form.get("file");
    const upload = file && typeof file !== "string" && file.size > 0 ? { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
    const orderId = str(form, "orderId");
    // optional line detail: qty__<poLineNo> and price__<poLineNo> (rupees per unit, excluding GST); a line with a quantity is billed
    const lines: { poLineNo: number; quantity: number; unitPricePaise: number }[] = [];
    for (const k of form.keys()) {
      const m = /^qty__(\d{1,3})$/.exec(k);
      if (!m || str(form, k) === "") continue;
      lines.push({ poLineNo: Number(m[1]), quantity: Number(str(form, k)), unitPricePaise: rupeesToPaise(numOrNull(form, `price__${m[1]}`)) });
    }
    await enquiry.recordSupplierInvoice(actorOf(session as SessionWithBusiness), {
      purchaseOrderId: str(form, "purchaseOrderId"),
      invoiceNumber: str(form, "invoiceNumber"),
      invoiceDate: str(form, "invoiceDate"),
      taxablePaise: rupeesToPaise(numOrNull(form, "taxable")),
      gstPaise: rupeesToPaise(numOrNull(form, "gst")),
      irn: str(form, "irn") || null,
      ackNo: str(form, "ackNo") || null,
      ackDate: str(form, "ackDate") || null,
      signedQr: str(form, "signedQr") || null,
      ewbNo: str(form, "ewbNo") || null,
      ewbValidUntil: str(form, "ewbValidUntil") || null,
      file: upload,
      lines: lines.length ? lines : null,
    });
    if (orderId) revalidatePath(`/orders/${orderId}`, "layout");
    return Response.json({ ok: true, data: null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
