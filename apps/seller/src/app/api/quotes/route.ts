import { DomainError } from "@cnote/core";
import { currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { QUOTE_UPLOAD_MAX_BYTES, sendQuote } from "@/features/conversations/send-quote";

// Send a quote WITH attachments (drawings, spec sheets; up to 3 x 5 MB). Server actions are capped at 2 MB app-wide (next.config.ts),
// so multipart posts land here with their own cap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business?.isSeller) throw new DomainError("forbidden", "Seller account required");
    const form = await readBoundedFormData(req, QUOTE_UPLOAD_MAX_BYTES);
    await sendQuote(form, session as SessionWithBusiness, { withFiles: true });
    return Response.json({ ok: true, data: null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
