import { DomainError } from "@cnote/core";
import { currentSession, errorResponse } from "@cnote/next-kit";
import { ensureKycPorts } from "@/features/kyc/ports";
import { identity } from "@/lib/services";

// Route handler (server actions cap bodies at 1 MB). One document per request; JPEG/PNG/WebP up to 5 MB.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX = 5 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const session = await currentSession();
    const business = session?.business;
    if (!session || !business) throw new DomainError("unauthenticated", "Please sign in again");
    if (!business.isSeller) throw new DomainError("forbidden", "Seller account required");
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX + 256 * 1024) throw new DomainError("validation", "The file is larger than 5 MB");
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) throw new DomainError("validation", "Expected a file upload");
    const form = await req.formData();
    const file = form.get("file");
    const sessionId = String(form.get("sessionId") ?? "");
    const docType = String(form.get("docType") ?? "");
    if (!(file instanceof File)) throw new DomainError("validation", "Choose a photo of the document");
    if (file.size > MAX) throw new DomainError("validation", "The file is larger than 5 MB");
    if (file.type === "application/pdf") throw new DomainError("validation", "PDFs are not supported yet. Upload a clear photo or screenshot of the first page (JPEG, PNG or WebP).");
    ensureKycPorts();
    const r = await identity.uploadKycDocument(
      { personId: session.personId, businessId: business.id },
      sessionId,
      { docType: docType as identity.KycDocType, bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type },
    );
    return Response.json({ ok: true, document: r.document }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
