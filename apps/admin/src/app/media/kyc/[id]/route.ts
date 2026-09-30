import { hasPrivilege } from "@cnote/admin";
import { readKycDocumentImage } from "@cnote/identity";
import { ensureKycPorts } from "@/features/kyc/ports";
import { getStaffFromSession } from "@/features/images/staff";

const deny = (status: number) => new Response(status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not found", { status, headers: { "Cache-Control": "no-store" } });

/** KYC document image bytes: staff with kyc.review only, never cached, never public (sensitive personal data). */
export async function GET(_req: Request, ctx: RouteContext<"/media/kyc/[id]">) {
  const { id } = await ctx.params;
  const auth = await getStaffFromSession();
  if (!auth) return deny(401);
  if (!auth.staff || !hasPrivilege(auth.staff, "kyc.review")) return deny(403);
  if (!/^[0-9a-f-]{36}$/.test(id)) return deny(404);
  ensureKycPorts();
  const img = await readKycDocumentImage(id);
  if (!img) return deny(404);
  return new Response(Buffer.from(img.bytes), {
    headers: { "Content-Type": img.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Referrer-Policy": "no-referrer" },
  });
}
