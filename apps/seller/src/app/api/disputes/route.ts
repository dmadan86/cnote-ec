import { DomainError } from "@cnote/core";
import { currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { DISPUTE_UPLOAD_MAX_BYTES, runDisputeIntent } from "@/features/disputes/run";

// Seller dispute intents that carry evidence files (respond / add evidence; photos, PDFs, voice notes; 8 MB per file, ADR-013).
// Server actions are capped at 2 MB app-wide (next.config.ts), so these multipart posts land here with their own cap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business?.isSeller) throw new DomainError("forbidden", "Seller account required");
    const form = await readBoundedFormData(req, DISPUTE_UPLOAD_MAX_BYTES);
    await runDisputeIntent(form, session as SessionWithBusiness, { withFiles: true });
    return Response.json({ ok: true, data: null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
