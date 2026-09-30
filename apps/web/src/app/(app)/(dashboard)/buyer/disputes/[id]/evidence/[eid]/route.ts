import { readEvidenceFileForParty } from "@/lib/disputes";
import { actorOf, currentSession } from "@cnote/next-kit";

/** Streams a private evidence file to a party of the dispute only (never public, never cacheable). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params;
  const s = await currentSession();
  if (!s?.business) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const f = await readEvidenceFileForParty(actorOf(s as never), id, eid);
  if (!f) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(Buffer.from(f.bytes), {
    headers: { "Content-Type": f.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
