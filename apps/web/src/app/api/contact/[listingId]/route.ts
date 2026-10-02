import { DomainError } from "@cnote/core";
import { CONTACT_CHANNELS, getUnlockedSupplierContact, recordSupplierContacted, type ContactChannel } from "@cnote/leadgen";
import { currentSession } from "@cnote/next-kit";
import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/paths";

// Supplier contact options after a legitimate unlock (docs/design/buyer-convenience.md; ADR-002/005).
// GET  -> { unlocked: false } or the supplier's call / WhatsApp / email details. The number is NEVER in static HTML:
//         the product page fetches this client-side, signed in only, and the answer is private + no-store.
// POST -> logs which channel the buyer used (SupplierContacted v1); the unlock is re-checked server-side.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Robots-Tag": "noindex" } as const;
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/contact/[listingId]">) {
  const { listingId } = await ctx.params;
  if (!isUuid(listingId)) return json(404, { error: "not_found" });
  const session = await currentSession().catch(() => null);
  if (!session) return json(200, { unlocked: false });
  try {
    return json(200, { ...(await getUnlockedSupplierContact(session.personId, listingId)) });
  } catch (err) {
    console.error("[web] /api/contact failed:", err instanceof Error ? err.message : err);
    return json(503, { error: "unavailable" });
  }
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/contact/[listingId]">) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return json(403, { error: "forbidden" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "unsupported_media_type" });
  const { listingId } = await ctx.params;
  if (!isUuid(listingId)) return json(404, { error: "not_found" });
  const session = await currentSession().catch(() => null);
  if (!session) return json(401, { error: "unauthenticated" });
  let channel: unknown;
  try {
    channel = ((await req.json()) as { channel?: unknown }).channel;
  } catch {
    return json(400, { error: "invalid" });
  }
  if (typeof channel !== "string" || !(CONTACT_CHANNELS as readonly string[]).includes(channel)) return json(400, { error: "invalid" });
  try {
    await recordSupplierContacted(session.personId, listingId, channel as ContactChannel);
    return json(200, { ok: true });
  } catch (err) {
    if (err instanceof DomainError) return json(err.code === "rate_limited" ? 429 : 403, { error: err.code });
    console.error("[web] /api/contact log failed:", err instanceof Error ? err.message : err);
    return json(503, { error: "unavailable" });
  }
}
