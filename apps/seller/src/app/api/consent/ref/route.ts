import { NextResponse, type NextRequest } from "next/server";
import { requireSellerConsent } from "@/features/consent/server";

// Stores the referral code (ADR-025) AFTER the visitor granted marketing consent on the page the `?ref=` link landed on (the proxy
// only stores it when consent already existed). Same origin, JSON, tiny, and a no-op without the grant.
export const dynamic = "force-dynamic";

const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { ref?: unknown } | null;
  const ref = typeof body?.ref === "string" ? body.ref : "";
  if (!REF_RE.test(ref)) return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  if (!requireSellerConsent(req, "marketing")) return NextResponse.json({ stored: false }, { headers: NO_STORE });
  const res = NextResponse.json({ stored: true }, { headers: NO_STORE });
  res.cookies.set("seller_ref", ref, { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  return res;
}
