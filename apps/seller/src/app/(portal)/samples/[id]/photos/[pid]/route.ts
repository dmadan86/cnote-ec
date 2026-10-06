import { actorOf, currentSession } from "@cnote/next-kit";
import { readSamplePhoto } from "@/lib/samples";

/** The buyer's evaluation photo, for a party of the sample request only (never public, never cacheable). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await ctx.params;
  const s = await currentSession();
  const gone = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!s?.business) return gone();
  const f = await readSamplePhoto(actorOf(s as never), id, pid);
  if (!f) return gone();
  return new Response(Buffer.from(f.bytes), {
    headers: { "Content-Type": f.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
