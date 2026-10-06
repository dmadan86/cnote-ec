import { audited, staffRolesByPerson, writeAudit } from "@cnote/admin";
import { iterateOpsLabels } from "@cnote/ai";
import { DomainError } from "@cnote/core";
import { type NextRequest, NextResponse } from "next/server";
import { LABEL_CSV_HEADER, labelCsvRow, labelJsonl, parseLabelFilters } from "@/features/ai/label-export";
import { actionContext } from "@/lib/auth";

// Export of labelled ops decisions as training data (ADR-008). Streams keyset pages, so memory stays flat. Requires
// `ai.labels.export`; the export is audited when it starts (with the filters) and again when it finishes (row count).
// Rows carry redacted inputs, prompt version, model id, the label, the labeller's ROLE (never a person) and the label day.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } as const;

export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await actionContext();
  } catch (err) {
    const code = err instanceof DomainError ? err.code : "unauthenticated";
    return NextResponse.json({ error: code }, { status: code === "forbidden" ? 403 : 401, headers: HEADERS });
  }
  const sp = req.nextUrl.searchParams;
  const { filters, format, problem } = parseLabelFilters({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined, capability: sp.get("capability") ?? undefined, format: sp.get("format") ?? undefined });
  if (problem) return NextResponse.json({ error: "invalid_filters", message: problem }, { status: 400, headers: HEADERS });

  let rows: ReturnType<typeof iterateOpsLabels>;
  try {
    // Authorises and writes the audit row BEFORE any data leaves; a denied attempt is audited too and throws forbidden.
    rows = await audited(ctx, "ai.labels.export", "ai.labels.export", { type: "ReviewItem" }, async () => iterateOpsLabels(filters, { rolesOf: staffRolesByPerson }), {
      format, filters: { from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null, capability: filters.capability ?? null },
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
    throw err;
  }

  const encoder = new TextEncoder();
  let count = 0;
  const finish = (error?: unknown) =>
    writeAudit({
      staffId: ctx.staff.id, privilege: "ai.labels.export", action: error ? "ai.labels.export.failed" : "ai.labels.export.completed", subject: { type: "ReviewItem" },
      details: { rows: count, format, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null,
    }).catch((e) => console.error("[admin] audit write failed", e));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (format === "csv") controller.enqueue(encoder.encode(`${LABEL_CSV_HEADER.join(",")}\r\n`));
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
        controller.enqueue(encoder.encode(format === "csv" ? `${labelCsvRow(value)}\r\n` : `${labelJsonl(value)}\n`));
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
  return new NextResponse(stream, {
    headers: {
      ...HEADERS,
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="ops-labels-${day}.${format}"`,
    },
  });
}
