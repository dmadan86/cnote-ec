import { getListingImageDelivery, getPreviewByToken, verifyPreviewToken } from "@cnote/catalogue";

// Image bytes for a not-live preview. Token-gated and limited to the images frozen in that version's snapshot
// (the public /media route refuses images of unpublished listings). Never cached.
const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } as const;

export async function GET(req: Request, ctx: RouteContext<"/preview/listing/[versionId]/media/[imageId]">) {
  const { versionId, imageId } = await ctx.params;
  const token = new URL(req.url).searchParams.get("token");
  const ok = verifyPreviewToken(token);
  if (!ok || ok.versionId !== versionId) return new Response("Not found", { status: 404, headers: NO_STORE });
  const preview = await getPreviewByToken(token);
  if (!preview || !preview.preview.imageIds.includes(imageId)) return new Response("Not found", { status: 404, headers: NO_STORE });
  const d = await getListingImageDelivery(imageId, { kind: "staff" });
  if (!d) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (d.kind === "redirect") return new Response(null, { status: 302, headers: { Location: d.url, ...NO_STORE } });
  return new Response(Buffer.from(d.bytes), { headers: { "Content-Type": d.contentType, "X-Content-Type-Options": "nosniff", ...NO_STORE } });
}
