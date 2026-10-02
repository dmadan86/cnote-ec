import { DomainError } from "@cnote/core";
import { currentSession, errorResponse, readBoundedFormData, type SessionWithBusiness } from "@cnote/next-kit";
import { postRfq, RFQ_UPLOAD_MAX_BYTES } from "@/features/enquiry/post-rfq";

// "Post your requirement" WITH drawings. Server actions are capped at 2 MB app-wide (next.config.ts), so multipart uploads land here with
// their own cap (RFQ_UPLOAD_MAX_BYTES). The route is excluded from the proxy matcher (src/proxy.ts) so Next does not buffer/truncate the body;
// the rfq form refreshes an expired access token via /api/me and retries once (@cnote/next-kit/upload-client).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business) throw new DomainError("forbidden", "Create your business profile first.");
    const form = await readBoundedFormData(req, RFQ_UPLOAD_MAX_BYTES);
    const enquiry = await postRfq(form, session as SessionWithBusiness, { withFiles: true });
    return Response.json({ ok: true, data: enquiry }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
