import { audited, hasPrivilege } from "@cnote/admin";
import { errorResponse } from "@cnote/next-kit";
import { uploadTemplateAsset } from "@cnote/templates";
import { getStaffFromSession } from "@/features/images/staff";
import { actionContext } from "@/lib/auth";

// Image upload for the template studio. A route handler (not a server action) because server actions cap request bodies
// at 1 MB by default while template images may be up to 2 MB. Same guarantees as an action: staff session, templates.manage
// (enforced by audited), audit trail, and a same-origin check (CSRF; the auth cookie is SameSite=Lax as well).
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  const auth = await getStaffFromSession();
  if (!auth) return Response.json({ error: "Please sign in again." }, { status: 401 });
  if (!auth.staff || !hasPrivilege(auth.staff, "templates.manage")) return Response.json({ error: "You don't have permission to upload images." }, { status: 403 });
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose an image file." }, { status: 422 });
    if (file.size > 2 * 1024 * 1024) return Response.json({ error: "Image is larger than 2 MB." }, { status: 422 });
    const alt = String(form.get("alt") ?? "").trim().slice(0, 300) || null;
    const ctx = await actionContext();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await audited(ctx, "templates.manage", "template.asset.upload", { type: "template_asset", id: null }, () => uploadTemplateAsset(bytes, { altText: alt, uploadedBy: ctx.staff.id }), { bytes: bytes.length });
    return Response.json({ id: asset.id, url: asset.url, width: asset.width, height: asset.height });
  } catch (err) {
    return errorResponse(err);
  }
}
