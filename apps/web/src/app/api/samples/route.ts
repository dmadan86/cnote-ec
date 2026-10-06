import { DomainError } from "@cnote/core";
import { currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { runSampleIntent, SAMPLE_UPLOAD_MAX_BYTES } from "@/features/samples/run";

// Sample evaluation WITH photos. Server actions are capped at 2 MB app-wide, so multipart posts land here with their own cap
// (SAMPLE_UPLOAD_MAX_BYTES). Excluded from the proxy matcher (src/proxy.ts); the form refreshes an expired access token via /api/me
// and retries once (@cnote/next-kit/upload-client).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business) throw new DomainError("forbidden", "Create your business profile first.");
    const form = await readBoundedFormData(req, SAMPLE_UPLOAD_MAX_BYTES);
    const { created } = await runSampleIntent(form, session as SessionWithBusiness, { withFiles: true });
    return Response.json({ ok: true, data: { created }, ...(created ? { redirect: `/buyer/samples/${created}` } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
