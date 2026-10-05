import { audited } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { exportJudgements } from "@cnote/search";
import { NextResponse } from "next/server";
import { actionContext } from "@/lib/auth";

// Export of staff relevance judgements in the shared judgement-file format (packages/search/src/relevance/format.ts), scored by
// `pnpm --filter @cnote/search eval:relevance -- --judgements <file>`. No personal data: queries are staff-typed. Audited.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } as const;

export async function GET() {
  let ctx;
  try {
    ctx = await actionContext();
  } catch (err) {
    const code = err instanceof DomainError ? err.code : "unauthenticated";
    return NextResponse.json({ error: code }, { status: code === "forbidden" ? 403 : 401, headers: HEADERS });
  }
  try {
    const details: Record<string, unknown> = {};
    const file = await audited(ctx, "search.read", "search.judgements.export", { type: "search_judgement" }, async () => exportJudgements(), details);
    if (!file.queries.length) return NextResponse.json({ error: "nothing_judged" }, { status: 404, headers: HEADERS });
    const day = new Date().toISOString().slice(0, 10);
    return new NextResponse(`${JSON.stringify(file, null, 2)}\n`, { headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="relevance-judgements-${day}.json"` } });
  } catch (err) {
    if (err instanceof DomainError && err.code === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
    throw err;
  }
}
