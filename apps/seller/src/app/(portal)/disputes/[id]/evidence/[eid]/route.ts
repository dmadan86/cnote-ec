import { actorOf, currentSession } from "@cnote/next-kit";
import { readEvidenceFileForParty } from "@/lib/disputes";

/** Private evidence file for a party of the dispute only. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params;
  const s = await currentSession();
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!s?.business) return notFound();
  const f = await readEvidenceFileForParty(actorOf(s as never), id, eid);
  if (!f) return notFound();
  return new Response(Buffer.from(f.bytes), {
    headers: { "Content-Type": f.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
