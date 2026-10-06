import { currentSession } from "@cnote/next-kit";
import { NextResponse, type NextRequest } from "next/server";
import { loadSellerAccountConsent } from "@/features/consent/ledger";

// The signed-in seller's cookie-consent ledger state (seller_analytics_cookies / seller_marketing_cookies), so a browser with no valid
// cookie, or an older one, can adopt the choice made on another device (@cnote/consent reconcileAccountConsent). Same origin, never
// cached, never indexed. Anonymous visitors get `{ signedIn: false }` without a database read. Mirrors apps/web /api/consent/account.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", Vary: "Cookie" } as const;

export async function GET(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const session = await currentSession().catch(() => null);
  if (!session) return NextResponse.json({ signedIn: false, analytics: null, marketing: null, functional: null }, { headers: HEADERS });
  try {
    return NextResponse.json(await loadSellerAccountConsent(session.personId), { headers: HEADERS });
  } catch (err) {
    console.error("[seller] /api/consent/account failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
}
