import { DomainError } from "@cnote/core";
import { currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { DISPUTE_UPLOAD_MAX_BYTES, runDisputeIntent } from "@/features/disputes/run";

// Buyer dispute intents that carry evidence files (open / respond / add evidence; photos, PDFs, voice notes; 8 MB per file, ADR-013).
// Server actions are capped at 2 MB app-wide, so these multipart posts land here with their own cap. Excluded from the proxy matcher
// (src/proxy.ts); the form refreshes an expired access token via /api/me and retries once (@cnote/next-kit/upload-client).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business) throw new DomainError("forbidden", "Create your business profile first.");
    const form = await readBoundedFormData(req, DISPUTE_UPLOAD_MAX_BYTES);
    const { created } = await runDisputeIntent(form, session as SessionWithBusiness, { withFiles: true });
    return Response.json({ ok: true, data: { created }, ...(created ? { redirect: `/buyer/disputes/${created}` } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
