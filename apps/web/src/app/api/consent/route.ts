import { recordCookieConsent } from "@cnote/compliance";
import { DomainError, rateLimit } from "@cnote/core";
import { currentSession } from "@cnote/next-kit";
import { clientIp } from "@cnote/security/client-ip";
import { NextResponse, type NextRequest } from "next/server";
import { syncCookieConsentToLedger } from "@/features/consent/ledger";
import { registryHashFor } from "@/features/consent/policy";
import { serverClearable } from "@/features/consent/registry";

// Cookie-consent receipt + server-side withdrawal (DPDP s.6(10) proof of consent; docs/design/cookie-consent.md).
// Called by the consent manager after every choice (client fetch with keepalive, so it works from the static pages).
//  1. Persists a receipt: consent id, policy version, per-category choices, GPC flag, action, locale, time, and the
//     personId when signed in. NO IP address and NO user agent are stored (the IP is only the rate-limit key).
//     Idempotent on (consentId, at): the client keeps an unacknowledged receipt in localStorage and resends it until 200.
//     The policy snapshot hash (what the visitor was shown) is added server-side from the committed snapshot.
//  1b. Signed in: mirrors the choice into the identity consent ledger (analytics_cookies / marketing_cookies) so it follows
//     the person across devices; the newer of ledger and receipt wins per purpose (features/consent/ledger.ts).
//  2. When marketing is not granted, expires the httpOnly cookies the browser cannot delete itself (cnote_vid, cnote_ad_click).
// Same-origin only, JSON only, tiny body, rate-limited per client IP. Never cached.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } as const;
const MAX_BODY_BYTES = 2048;
/** Generous for shared NATs (carrier-grade NAT is common in India) yet far above any real person's number of choices. */
export const CONSENT_RATE = { count: 30, windowSeconds: 600 } as const;

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
  // CSRF: same origin only (defence in depth on top of SameSite=Lax; same rule as @cnote/next-kit's auth route).
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return json(403, { error: "forbidden" });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "unsupported_media_type" });
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });

  // Fails OPEN if Redis is down: the route calls no paid vendor and a lost receipt is worse than an unmetered write.
  try {
    if (!(await rateLimit(`consent:${clientIp(req.headers) ?? "unknown"}`, CONSENT_RATE.count, CONSENT_RATE.windowSeconds))) {
      return json(429, { error: "rate_limited", retryAfterSeconds: CONSENT_RATE.windowSeconds });
    }
  } catch (err) {
    console.error("[web] /api/consent rate limiter unavailable:", err instanceof Error ? err.message : err);
  }

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json(400, { error: "invalid" });
  const input = body as Record<string, unknown>;
  // Server-side Sec-GPC header is authoritative in addition to the client flag (Global Privacy Control spec).
  if (typeof input.gpc === "boolean" && req.headers.get("sec-gpc") === "1") input.gpc = true;

  const session = await currentSession().catch(() => null);
  let saved: { id: string } | null = null;
  try {
    const version = typeof input.policyVersion === "number" ? input.policyVersion : 0;
    saved = await recordCookieConsent(input, { personId: session?.personId ?? null, registryHash: registryHashFor(version) });
  } catch (err) {
    if (err instanceof DomainError && err.code === "validation") return json(400, { error: "invalid", field: (err.details as { field?: string } | undefined)?.field ?? null });
    console.error("[web] /api/consent failed:", err instanceof Error ? err.message : err);
  }

  if (saved && session?.personId && typeof input.analytics === "boolean" && typeof input.marketing === "boolean") {
    const functional = input.functional === true; // absent (an older queued receipt) means not granted
    // Best effort: the receipt is the proof, the ledger is a convenience for other devices. Never fail the request over it.
    await syncCookieConsentToLedger(session.personId, { analytics: input.analytics, marketing: input.marketing, functional }, { clientAt: typeof input.at === "number" ? input.at : undefined }).catch((err) =>
      console.error("[web] /api/consent ledger sync failed:", err instanceof Error ? err.message : err),
    );
  }

  const res = json(saved ? 200 : 503, saved ? { ok: true } : { error: "unavailable" });
  // Withdrawal must take effect even when the receipt write failed: expire the httpOnly marketing cookies.
  if (input.marketing === false) {
    for (const c of serverClearable("marketing")) {
      res.cookies.set(c.name, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0, expires: new Date(0) });
    }
  }
  return res;
}
