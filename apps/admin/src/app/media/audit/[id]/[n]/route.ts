import { hasPrivilege } from "@cnote/admin";
import { readAuditPhoto } from "@cnote/identity";
import { ensureKycPorts } from "@/features/kyc/ports";
import { getStaffFromSession } from "@/features/images/staff";

const deny = (status: number) => new Response(status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not found", { status, headers: { "Cache-Control": "no-store" } });

/** T3 partner site photo: staff with audits.manage only, never cached, never public. */
export async function GET(_req: Request, ctx: RouteContext<"/media/audit/[id]/[n]">) {
  const { id, n } = await ctx.params;
  const auth = await getStaffFromSession();
  if (!auth) return deny(401);
  if (!auth.staff || !hasPrivilege(auth.staff, "audits.manage")) return deny(403);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{1,2}$/.test(n)) return deny(404);
  ensureKycPorts();
  const img = await readAuditPhoto(id, Number(n));
  if (!img) return deny(404);
  return new Response(Buffer.from(img.bytes), {
    headers: { "Content-Type": img.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Referrer-Policy": "no-referrer" },
  });
}
