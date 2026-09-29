import { hasPrivilege } from "@cnote/admin";
import { readTemplateAsset } from "@cnote/templates";
import { getStaffFromSession } from "@/features/images/staff";

const deny = (status: number) => new Response(status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not found", { status, headers: { "Cache-Control": "no-store" } });

/** Template images for the editor (the public copy is served by apps/web; this one works when web isn't running). Staff with templates.read only. */
export async function GET(_req: Request, ctx: RouteContext<"/media/template-assets/[id]">) {
  const { id } = await ctx.params;
  const auth = await getStaffFromSession();
  if (!auth) return deny(401);
  if (!auth.staff || !hasPrivilege(auth.staff, "templates.read")) return deny(403);
  const img = await readTemplateAsset(id);
  if (!img) return deny(404);
  return new Response(Buffer.from(img.bytes), {
    headers: { "Content-Type": img.contentType, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
