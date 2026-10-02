import { currentSession } from "@cnote/next-kit";
import { NextResponse, type NextRequest } from "next/server";
import { loadAccountConsent } from "@/features/consent/ledger";

// The signed-in person's cookie-consent ledger state (analytics_cookies / marketing_cookies), so a browser with no valid
// cookie, or an older one, can adopt the choice made on another device (features/consent/account-sync.ts). Same origin,
// never cached, never indexed. Anonymous visitors get `{ signedIn: false }` without a database read.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", Vary: "Cookie" } as const;

export async function GET(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const session = await currentSession().catch(() => null);
  if (!session) return NextResponse.json({ signedIn: false, analytics: null, marketing: null }, { headers: HEADERS });
  try {
    return NextResponse.json(await loadAccountConsent(session.personId), { headers: HEADERS });
  } catch (err) {
    console.error("[web] /api/consent/account failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  }
}
