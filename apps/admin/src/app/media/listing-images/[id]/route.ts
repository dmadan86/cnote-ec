import { readListingImage } from "@cnote/catalogue";
import { canViewImages } from "@/features/images/privilege";
import { getStaffFromSession } from "@/features/images/staff";

const deny = (status: number) => new Response(status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not found", { status, headers: { "Cache-Control": "no-store" } });

/** Any-status image bytes for staff who can view the queue. Session + privilege checked here (the proxy only checks a session). */
export async function GET(_req: Request, ctx: RouteContext<"/media/listing-images/[id]">) {
  const { id } = await ctx.params;
  const auth = await getStaffFromSession();
  if (!auth) return deny(401);
  if (!auth.staff || !canViewImages(auth.staff)) return deny(403);
  const img = await readListingImage(id, { kind: "staff" });
  if (!img) return deny(404);
  return new Response(Buffer.from(img.bytes), {
    headers: { "Content-Type": img.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
