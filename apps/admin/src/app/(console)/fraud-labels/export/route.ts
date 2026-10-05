import { audited } from "@cnote/admin";
import { exportFakeLeadLabelsCsv } from "@cnote/enquiry";
import { hasPrivilege } from "@cnote/admin";
import { actionContext } from "@/lib/auth";

/** Labelled-data CSV (ADR-002). Staff with enquiries.review only; no free text, formula-injection safe; every download is audited. */
export async function GET() {
  try {
    const ctx = await actionContext();
    if (!hasPrivilege(ctx.staff, "enquiries.review")) return new Response("Forbidden", { status: 403 });
    let csv = "";
    await audited(ctx, "enquiries.review", "enquiry.export_labels", { type: "enquiry", id: "labels" }, async () => { csv = await exportFakeLeadLabelsCsv(); }, {});
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="fake-lead-labels.csv"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
}
