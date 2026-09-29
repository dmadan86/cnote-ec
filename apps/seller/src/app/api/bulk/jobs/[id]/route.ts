import { getJob } from "@cnote/bulk";
import { errorResponse } from "@cnote/next-kit";
import { bulkActor } from "@/features/bulk/route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Job status for polling. Ownership is checked inside getJob. */
export async function GET(_req: Request, ctx: RouteContext<"/api/bulk/jobs/[id]">) {
  try {
    const { id } = await ctx.params;
    return Response.json({ ok: true, job: await getJob(await bulkActor(), id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
