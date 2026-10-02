import { audited, writeAudit } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { iterateCookieConsentReceipts } from "@cnote/compliance";
import { type NextRequest, NextResponse } from "next/server";
import { CSV_HEADER, csvRow, parseConsentFilters } from "@/features/compliance/consent-filters";
import { actionContext } from "@/lib/auth";

// CSV export of cookie-consent receipts (DPDP s.6(10) evidence for the Grievance Officer / Data Protection Board).
// Streams keyset pages straight to the client, so memory stays flat however large the log is. Requires
// `compliance.consent`; the export is audited when it starts (with the filters) and again when it finishes (row count).
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } as const;
/** Hard ceiling: an export of more than this should be narrowed by date, not downloaded in one go. */
const MAX_ROWS = 250_000;

export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await actionContext();
  } catch (err) {
    const code = err instanceof DomainError ? err.code : "unauthenticated";
    return NextResponse.json({ error: code }, { status: code === "forbidden" ? 403 : 401, headers: HEADERS });
  }
  const sp = req.nextUrl.searchParams;
  const { filters, problem } = parseConsentFilters({ q: sp.get("q") ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined, v: sp.get("v") ?? undefined, action: sp.get("action") ?? undefined, app: sp.get("app") ?? undefined });
  if (problem) return NextResponse.json({ error: "invalid_filters", message: problem }, { status: 400, headers: HEADERS });

  let rows: AsyncGenerator<Parameters<typeof csvRow>[0]>;
  try {
    // Authorises and writes the audit row BEFORE any data leaves; a denied attempt is audited too and throws forbidden.
    rows = await audited(ctx, "compliance.consent", "consent.export", { type: "CookieConsentReceipt" }, async () => iterateCookieConsentReceipts(filters, { maxRows: MAX_ROWS }), {
      format: "csv",
      filters: { q: filters.q ?? null, from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null, policyVersion: filters.policyVersion ?? null, action: filters.action ?? null, app: filters.app ?? null },
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
    throw err;
  }

  const encoder = new TextEncoder();
  let count = 0;
  const finish = (error?: unknown) =>
    writeAudit({
      staffId: ctx.staff.id, privilege: "compliance.consent", action: error ? "consent.export.failed" : "consent.export.completed", subject: { type: "CookieConsentReceipt" },
      details: { rows: count, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null,
    }).catch((e) => console.error("[admin] audit write failed", e));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${CSV_HEADER.join(",")}\r\n`));
    },
    async pull(controller) {
      try {
        const { value, done } = await rows.next();
        if (done) {
          controller.close();
          await finish();
          return;
        }
        count++;
        controller.enqueue(encoder.encode(`${csvRow(value)}\r\n`));
      } catch (err) {
        controller.error(err);
        await finish(err);
      }
    },
    async cancel() {
      await rows.return(undefined);
      await finish(new Error("client disconnected"));
    },
  });
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, { headers: { ...HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="cookie-consent-receipts-${day}.csv"` } });
}
