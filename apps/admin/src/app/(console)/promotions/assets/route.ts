import { audited, hasPrivilege } from "@cnote/admin";
import { errorResponse } from "@cnote/next-kit";
import { uploadTemplateAsset } from "@cnote/templates";
import { getStaffFromSession } from "@/features/images/staff";
import { actionContext } from "@/lib/auth";

// Creative upload for the promotion editor. Same media pipeline as the template studio (@cnote/media public bucket, magic-byte
// sniffing, 2 MB cap), gated by promotions.manage and audited. A route handler because server actions cap bodies at 1 MB.
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  const auth = await getStaffFromSession();
  if (!auth) return Response.json({ error: "Please sign in again." }, { status: 401 });
  if (!auth.staff || !hasPrivilege(auth.staff, "promotions.manage")) return Response.json({ error: "You don't have permission to upload images." }, { status: 403 });
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose an image file." }, { status: 422 });
    if (file.size > 2 * 1024 * 1024) return Response.json({ error: "Image is larger than 2 MB." }, { status: 422 });
    const alt = String(form.get("alt") ?? "").trim().slice(0, 300) || null;
    const ctx = await actionContext();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await audited(ctx, "promotions.manage", "promotion.asset.upload", { type: "template_asset", id: null }, () => uploadTemplateAsset(bytes, { altText: alt, uploadedBy: ctx.staff.id }), { bytes: bytes.length });
    return Response.json({ url: asset.url, width: asset.width, height: asset.height });
  } catch (err) {
    return errorResponse(err);
  }
}
