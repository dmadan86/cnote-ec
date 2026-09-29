import { DomainError } from "@cnote/core";
import { buildImportTemplate, buildStarterKit } from "@cnote/bulk";
import { errorResponse } from "@cnote/next-kit";
import { bulkActor } from "@/features/bulk/route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = {
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  csv: ["text/csv; charset=utf-8", "csv"],
  kit: ["application/zip", "zip"],
} as const;

/** GET ?format=xlsx|csv|kit[&category=<slug>]: import template / starter kit with examples. */
export async function GET(req: Request) {
  try {
    await bulkActor();
    const sp = new URL(req.url).searchParams;
    const format = sp.get("format") ?? "xlsx";
    if (format !== "xlsx" && format !== "csv" && format !== "kit") throw new DomainError("validation", "Unknown template format");
    const category = sp.get("category") || undefined;
    const bytes = format === "kit" ? await buildStarterKit({ categorySlug: category }) : await buildImportTemplate({ format, categorySlug: category });
    const [type, ext] = TYPES[format];
    const name = format === "kit" ? "cnote-import-starter-kit" : "cnote-import-template";
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}${category ? `-${category.replace(/[^a-z0-9-]/gi, "")}` : ""}.${ext}"`, "Cache-Control": "private, max-age=300" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
