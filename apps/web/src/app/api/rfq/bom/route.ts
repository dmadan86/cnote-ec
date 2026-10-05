import { readSheetMatrix } from "@cnote/bulk/sheet";
import { DomainError, rateLimit } from "@cnote/core";
import { currentSession, errorResponse, readBoundedFormData } from "@cnote/next-kit";
import { BOM_TEMPLATE_CSV, detectMapping, MAX_BOM_LINES } from "@/features/enquiry/bom";

// Bill-of-materials upload for the RFQ form (docs/design/rfq-multiline.md). The file is read in memory only: nothing is stored, no
// formula is evaluated, and the buyer reviews the parsed rows in the editor before anything is posted. Own body cap (readBoundedFormData),
// kept out of the proxy matcher like /api/rfq (src/proxy.ts); the form refreshes an expired token via /api/me and retries once.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOM_MAX_BYTES = 1024 * 1024; // 1 MB is thousands of BOM rows; the RFQ itself takes 50
const LIMITS = { maxBytes: BOM_MAX_BYTES, maxRows: MAX_BOM_LINES * 4 + 1, maxColumns: 30 };

export async function POST(req: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous caller can never make the server buffer an upload.
    const session = await currentSession();
    if (!session) throw new DomainError("unauthenticated", "Please sign in again.");
    if (!session.business) throw new DomainError("forbidden", "Create your business profile first.");
    if (!(await rateLimit(`rfq:bom:${session.personId}`, 20, 600))) throw new DomainError("rate_limited", "Too many uploads. Please wait a few minutes.");
    const form = await readBoundedFormData(req, BOM_MAX_BYTES + 64 * 1024);
    const file = form.get("file");
    if (!file || typeof file === "string" || file.size === 0) throw new DomainError("validation", "Choose a .csv or .xlsx file.");
    const sheet = await readSheetMatrix(new Uint8Array(await file.arrayBuffer()), file.name, LIMITS);
    const [headers, ...data] = sheet.rows;
    return Response.json(
      { ok: true, data: { format: sheet.format, headers, rows: data, mapping: detectMapping(headers!), truncated: sheet.truncated } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** The downloadable template. Static; no session needed. */
export function GET() {
  return new Response(`﻿${BOM_TEMPLATE_CSV}`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="rfq-bill-of-materials-template.csv"', "Cache-Control": "public, max-age=86400" },
  });
}
