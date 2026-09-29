import { domainCheckResponse } from "@cnote/domains";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Reachability probe for custom domains. The verification worker fetches https://<host>/.well-known/cnote-domain-check
 * and expects the per-host HMAC token, proving the request reached OUR web app through the seller's domain + edge TLS.
 * Only hosts registered as a storefront domain get an answer; the token is a keyed hash of the host and reveals nothing else.
 */
export async function GET(req: NextRequest) {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0]!.trim();
  const body = await domainCheckResponse(host).catch(() => null);
  if (!body) return NextResponse.json({ error: "unknown host" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json(body, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
