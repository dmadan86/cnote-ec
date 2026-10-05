// Buyer-reachability IVR status callback (ADR-002). NOT under /v1, NOT API-key authenticated, NOT in the OpenAPI document.
// Authenticity is decided by the telephony adapter in @cnote/enquiry: HMAC-SHA256 of the raw body in `x-reachability-signature`
// (REACHABILITY_WEBHOOK_SECRET) or, for vendors that cannot sign (Exotel Passthru), a per-check token in `?check=&token=`
// (HMAC of the check id under REACHABILITY_URL_SECRET; the master secret never appears in a URL). The body only names the call and
// the digit pressed. GET is accepted because Exotel's Passthru applet issues GETs. The URL is never logged here.
import { DomainError, rateLimit } from "@cnote/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { readBodyCapped } from "../../lib/body";
import { clientIp } from "@cnote/security/client-ip";

const MAX_BODY_BYTES = 50_000;
const ip = (c: Context): string => clientIp(c.req.raw.headers) ?? "unknown";

export const reachabilityWebhook = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  if (!(await rateLimit(`reach-hook:${ip(c)}`, 240, 60))) return c.text("Too many requests", 429, { "Retry-After": "60" });
  let raw = "";
  if (c.req.method === "POST") {
    const bytes = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
    if (!bytes) return c.text("Payload too large", 413);
    raw = new TextDecoder().decode(bytes);
  }
  const { handleReachabilityCallback } = await import("@cnote/enquiry");
  try {
    const r = await handleReachabilityCallback(raw, Object.fromEntries(c.req.raw.headers.entries()), new URL(c.req.url).searchParams);
    return c.json({ ok: true, outcome: r.outcome });
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === "forbidden") return c.text("Invalid credentials", 401);
      if (err.code === "validation") return c.text("Bad request", 400);
      if (err.code === "not_found") return c.text("Not found", 404); // telephony is not enabled here
    }
    console.error(`[${c.get("requestId")}] reachability webhook failed`, err instanceof Error ? err.message : "error");
    return c.text("Unavailable", 503); // ask the vendor to redeliver
  }
}
reachabilityWebhook.post("/", handle);
reachabilityWebhook.get("/", handle);
