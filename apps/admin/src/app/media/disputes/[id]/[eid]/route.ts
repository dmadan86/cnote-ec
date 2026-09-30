import { hasPrivilege } from "@cnote/admin";
import { readEvidenceFileForStaff } from "@/lib/disputes";
import { getStaffFromSession } from "@/features/images/staff";

const deny = (status: number) => new Response(status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not found", { status, headers: { "Cache-Control": "no-store" } });

/** Dispute evidence bytes: staff with disputes.read only, never cached, never public (personal data, ADR-010). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params;
  const auth = await getStaffFromSession();
  if (!auth) return deny(401);
  if (!auth.staff || !hasPrivilege(auth.staff, "disputes.read")) return deny(403);
  const f = await readEvidenceFileForStaff(id, eid);
  if (!f) return deny(404);
  return new Response(Buffer.from(f.bytes), {
    headers: { "Content-Type": f.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Referrer-Policy": "no-referrer" },
  });
}
