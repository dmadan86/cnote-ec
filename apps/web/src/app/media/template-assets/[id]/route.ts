import { readTemplateAsset } from "@cnote/templates";

// Public: images used inside emails/templates must load in any mail client. Only files uploaded through the
// template studio exist here (ids are random UUIDs); everything else is a 404.
export async function GET(req: Request, ctx: RouteContext<"/media/template-assets/[id]">) {
  const { id } = await ctx.params;
  const img = await readTemplateAsset(id);
  if (!img) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const etag = `"${img.sha256}"`;
  const headers = {
    "Content-Type": img.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Buffer.from(img.bytes), { headers });
}
