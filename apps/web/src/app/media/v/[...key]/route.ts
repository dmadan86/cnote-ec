import { getPublicMediaStore, isValidMediaKey } from "@cnote/media";

// Local-driver only: serves the PUBLIC bucket (approved derivatives, template assets) from disk at /media/v/<key>.
// With r2/s3 the public URLs point straight at the CDN (MEDIA_PUBLIC_BASE_URL) and this route redirects there.
// Keys are content-addressed by random UUIDs + width, so responses are immutable.
export async function GET(_req: Request, ctx: RouteContext<"/media/v/[...key]">) {
  const { key: parts } = await ctx.params;
  const key = parts.join("/");
  if (!isValidMediaKey(key)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const store = getPublicMediaStore();
  if (store.driver !== "local") {
    const url = store.publicUrl(key);
    return url ? new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "public, max-age=3600" } }) : new Response("Not found", { status: 404 });
  }
  const obj = await store.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(Buffer.from(obj.bytes), {
    headers: { "Content-Type": obj.contentType, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
