// ONDC network endpoints (ADR-017). NOT under /v1, NOT API-key authenticated, NOT in the OpenAPI document:
// authenticity is the BAP's signed Authorization header (ed25519 + BLAKE2b-512), verified against the ONDC registry in
// @cnote/ondc. Every route answers 404 while ONDC_ENABLED is off. Handlers only ACK/NACK; work is queued.
//
// Mount once, at the root:   app.route("/", ondcRoutes);
//   POST /ondc/{search|select|init|confirm|status|cancel|issue|issue_status}   Beckn + IGM requests from buyer apps / the gateway
//        (search also carries X-Gateway-Authorization, verified in @cnote/ondc)
//   POST /on_subscribe                                      registry challenge (x25519 + AES-256-ECB)
//   GET  /ondc-site-verification.html                       signed request_id for registry site verification
import { rateLimit } from "@cnote/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { readBodyCapped } from "../../lib/body";
import { clientIp } from "@cnote/security/client-ip";

const MAX_BODY_BYTES = 512_000;
const ip = (c: Context): string => clientIp(c.req.raw.headers) ?? "unknown";
const ondc = () => import("@cnote/ondc");

export const ondcRoutes = new Hono<AppEnv>();

ondcRoutes.post("/ondc/:action", async (c) => {
  const m = await ondc();
  if (!m.isEnabled()) return c.json({ error: "not found" }, 404);
  const action = c.req.param("action");
  if (!(m.INBOUND_ACTIONS as readonly string[]).includes(action)) return c.json({ error: "not found" }, 404);
  // Generous: the gateway fans out searches. Keyed by the sender's declared IP, not by an unauthenticated field.
  if (!(await rateLimit(`ondc:${ip(c)}`, 600, 60))) return c.json(m.nack(m.ERROR_CODES.unavailable, "rate limited"), 429, { "Retry-After": "60" });
  const bytes = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
  if (!bytes) return c.json(m.nack(m.ERROR_CODES.badRequest, "payload too large"), 413);
  const rawBody = new TextDecoder().decode(bytes);
  try {
    const r = await m.receiveInbound({ action, rawBody, authorization: c.req.header("authorization"), gatewayAuthorization: c.req.header("x-gateway-authorization") });
    return c.json(r.body as object, r.status as 200);
  } catch (err) {
    console.error(`[${c.get("requestId")}] ondc ${action} failed`, err);
    return c.json(m.nack(m.ERROR_CODES.unavailable), 503);
  }
});

ondcRoutes.post("/on_subscribe", async (c) => {
  const m = await ondc();
  if (!m.isEnabled()) return c.json({ error: "not found" }, 404);
  if (!(await rateLimit(`ondc-sub:${ip(c)}`, 30, 60))) return c.json({ error: "rate limited" }, 429, { "Retry-After": "60" });
  const rawBytes = await readBodyCapped(c.req.raw, 10_000);
  if (!rawBytes) return c.json({ error: "payload too large" }, 413);
  const raw = new TextDecoder().decode(rawBytes);
  if (raw.length > 10_000) return c.json({ error: "payload too large" }, 413);
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* handled below as a bad request */
  }
  const r = m.handleOnSubscribe(json);
  return c.json(r.body, r.status as 200);
});

ondcRoutes.get("/ondc-site-verification.html", async (c) => {
  const m = await ondc();
  const html = m.siteVerification();
  return html ? c.html(html) : c.text("Not found", 404);
});
