import { readSamplePhoto } from "@/lib/samples";
import { actorOf, currentSession } from "@cnote/next-kit";

/** Streams an evaluation photo to a party of the sample request only (never public, never cacheable). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await ctx.params;
  const s = await currentSession();
  if (!s?.business) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const f = await readSamplePhoto(actorOf(s as never), id, pid);
  if (!f) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(Buffer.from(f.bytes), {
    headers: { "Content-Type": f.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
