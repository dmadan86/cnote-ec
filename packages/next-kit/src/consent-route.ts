// POST /api/consent for every app that shows a cookie banner (buyer web, seller): the cookie-consent receipt + server-side
// withdrawal (DPDP s.6(10) proof of consent; docs/design/cookie-consent.md). Called by the consent manager after every choice (client
// fetch with keepalive, so it works from static pages).
//  1. Persists a receipt through the injected `record` (@cnote/compliance `recordCookieConsent`; next-kit may not depend on compliance,
//     which sits above the domain modules): consent id, policy version, per-category choices, GPC flag, action, locale, time, the
//     APP the notice was shown in, and the personId when signed in. NO IP address and NO user agent are stored (the IP is only the
//     rate-limit key). Idempotent on (consentId, at): the client keeps an unacknowledged receipt in localStorage and resends it until 200.
//     The policy snapshot hash (what the visitor was shown) is added server-side from the app's committed snapshot.
//  2. `onSaved` lets an app add a follow-up (the buyer web mirrors the choice into the identity consent ledger). Best effort.
//  3. For every optional category that is not granted, expires the app's httpOnly cookies of that category (the browser cannot delete them).
// Same-origin only, JSON only, tiny body, rate-limited per client IP. Never cached.
import { OPTIONAL_CATEGORIES, serverClearable, type ConsentApp, type StorageEntry } from "@cnote/consent";
import { DomainError, rateLimit } from "@cnote/core";
import { clientIp } from "@cnote/security/client-ip";
import { NextResponse, type NextRequest } from "next/server";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } as const;
const MAX_BODY_BYTES = 2048;
/** Generous for shared NATs (carrier-grade NAT is common in India) yet far above any real person's number of choices. */
export const CONSENT_RATE = { count: 30, windowSeconds: 600 } as const;

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export interface ConsentRouteOptions {
  app: ConsentApp;
  /** log prefix, e.g. "[web]" */
  logTag: string;
  /** current signed-in session of THIS app's realm, or null */
  getSession: () => Promise<{ personId: string } | null>;
  /** persists one receipt; throws DomainError("validation") for a bad body */
  record: (input: unknown, ctx: { app: ConsentApp; personId: string | null; registryHash: string | null }) => Promise<{ id: string }>;
  /** sha256 of the committed policy snapshot of a version, or null when unknown */
  registryHashFor: (version: number) => string | null;
  /** the app's storage registry: httpOnly cookies of a category the visitor did not grant are expired here (the browser cannot delete them) */
  registry: readonly StorageEntry[];
  /** after a saved receipt of a signed-in person; failures are logged, never surfaced */
  onSaved?: (input: Record<string, unknown>, session: { personId: string }) => Promise<unknown>;
}

export function createConsentPost(opts: ConsentRouteOptions): (req: NextRequest) => Promise<NextResponse> {
  return async function POST(req: NextRequest) {
    // CSRF: same origin only (defence in depth on top of SameSite=Lax; same rule as this package's auth route).
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
      console.error(`${opts.logTag} /api/consent rate limiter unavailable:`, err instanceof Error ? err.message : err);
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

    const session = await opts.getSession().catch(() => null);
    let saved: { id: string } | null = null;
    try {
      const version = typeof input.policyVersion === "number" ? input.policyVersion : 0;
      saved = await opts.record(input, { app: opts.app, personId: session?.personId ?? null, registryHash: opts.registryHashFor(version) });
    } catch (err) {
      if (err instanceof DomainError && err.code === "validation") return json(400, { error: "invalid", field: (err.details as { field?: string } | undefined)?.field ?? null });
      console.error(`${opts.logTag} /api/consent failed:`, err instanceof Error ? err.message : err);
    }

    if (saved && session?.personId && opts.onSaved) {
      // Best effort: the receipt is the proof, anything else is a convenience. Never fail the request over it.
      await opts.onSaved(input, { personId: session.personId }).catch((err) => console.error(`${opts.logTag} /api/consent follow-up failed:`, err instanceof Error ? err.message : err));
    }

    const res = json(saved ? 200 : 503, saved ? { ok: true } : { error: "unavailable" });
    // Withdrawal must take effect even when the receipt write failed: expire the httpOnly cookies of every category not granted.
    for (const category of OPTIONAL_CATEGORIES) {
      if (input[category] !== false) continue;
      for (const c of serverClearable(opts.registry, category)) {
        res.cookies.set(c.name, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0, expires: new Date(0) });
      }
    }
    return res;
  };
}
