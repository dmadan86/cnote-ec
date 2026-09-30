import { recordClick } from "@cnote/ads";
import { currentSession, requestContext } from "@cnote/next-kit";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isLocale, localizePath } from "@/i18n/config";
import { AD_CLICK_COOKIE, VISITOR_COOKIE } from "@/features/ads/slots";

// Sponsored click redirect (ADR-024): verifies the signed single-use token, records the click (valid / pending / invalid,
// charged only when valid), then 302s to the product. Never cached, never indexed, and it always redirects, even on failure.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "origin" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const lp = req.nextUrl.searchParams.get("l") ?? "en";
  const locale = isLocale(lp) ? lp : "en";
  const existing = req.cookies.get(VISITOR_COOKIE)?.value;
  const visitorId = existing ?? randomUUID();
  let target = localizePath("/", locale);
  let clickId: string | null = null;
  try {
    const [session, rc] = await Promise.all([currentSession().catch(() => null), requestContext()]);
    const out = await recordClick(token, { visitorId, ip: rc.ip, userAgent: rc.userAgent, personId: session?.personId ?? null, businessId: session?.business?.id ?? null });
    if (out.status !== "invalid_token") target = localizePath(`/p/${out.listingId}`, locale);
    if (out.status === "recorded" && (out.validity === "valid" || out.validity === "pending")) clickId = out.clickId;
  } catch (err) {
    console.error("[web] ad click failed:", err instanceof Error ? err.message : err);
  }
  const res = NextResponse.redirect(new URL(target, req.nextUrl.origin), { status: 302, headers: HEADERS });
  const cookie = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };
  if (!existing) res.cookies.set(VISITOR_COOKIE, visitorId, { ...cookie, maxAge: 60 * 60 * 24 * 30 });
  // short-lived attribution cookie: the enquiry flow may pass it to ads.attributeEnquiry (7-day window)
  if (clickId) res.cookies.set(AD_CLICK_COOKIE, clickId, { ...cookie, maxAge: 60 * 60 * 24 * 7 });
  return res;
}
