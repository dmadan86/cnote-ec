import { listCookieConsentReceipts } from "@cnote/compliance";
import { rateLimit } from "@cnote/core";
import { clientIp } from "@cnote/security/client-ip";
import { NextResponse, type NextRequest } from "next/server";
import { registryHashFor } from "@/features/consent/policy";
import { CONSENT_COOKIE, CONSENT_POLICY_UPDATED, CONSENT_POLICY_VERSION, consentIdFromCookieValue } from "@/features/consent/state";

// "Download my consent record" (DPDP s.6(10), s.11 access; GDPR Art 7(1)): the visitor's own consent history as JSON.
// Keyed ONLY by the consent id in the visitor's own `cnote_consent` cookie, so nobody can read another browser's record
// without already holding that cookie. Same origin, never cached. The person id and any internal row id stay out of it.
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", Vary: "Cookie" } as const;
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { ...HEADERS, ...extra } });

export async function GET(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return json(403, { error: "forbidden" });
  const consentId = consentIdFromCookieValue(req.cookies.get(CONSENT_COOKIE)?.value);
  if (!consentId) return json(404, { error: "no_consent_record" });
  try {
    if (!(await rateLimit(`consent-receipt:${clientIp(req.headers) ?? "unknown"}`, 30, 600))) return json(429, { error: "rate_limited" });
  } catch (err) {
    console.error("[web] /api/consent/receipt rate limiter unavailable:", err instanceof Error ? err.message : err);
  }
  let rows;
  try {
    rows = await listCookieConsentReceipts(consentId);
  } catch (err) {
    console.error("[web] /api/consent/receipt failed:", err instanceof Error ? err.message : err);
    return json(503, { error: "unavailable" });
  }
  const body = {
    consentId,
    generatedAt: new Date().toISOString(),
    currentPolicy: { version: CONSENT_POLICY_VERSION, updated: CONSENT_POLICY_UPDATED, registryHash: registryHashFor(CONSENT_POLICY_VERSION) },
    receipts: rows.map((r) => ({
      recordedAt: r.createdAt,
      choiceAt: r.clientAt ? new Date(r.clientAt * 1000).toISOString() : null,
      action: r.action,
      analytics: r.analytics,
      marketing: r.marketing,
      globalPrivacyControl: r.gpc,
      policyVersion: r.policyVersion,
      registryHash: r.registryHash,
      language: r.locale,
      signedIn: r.personId !== null,
    })),
  };
  return json(200, body, { "Content-Disposition": `attachment; filename="consent-record-${consentId.slice(0, 8)}.json"` });
}
