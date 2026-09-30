// WhatsApp Cloud API webhook (Meta). NOT under /v1, NOT API-key authenticated, NOT in the OpenAPI document:
// authenticity is the X-Hub-Signature-256 HMAC over the raw body (docs/design/whatsapp-channel.md).
import { rateLimit } from "@cnote/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { clientIp } from "@cnote/security/client-ip";

const MAX_BODY_BYTES = 1_000_000;

const ip = (c: Context): string => clientIp(c.req.raw.headers) ?? "unknown";

export const whatsappWebhook = new Hono<AppEnv>();

// GET: subscription handshake. Meta sends hub.mode=subscribe, hub.verify_token, hub.challenge.
whatsappWebhook.get("/", async (c) => {
  if (!(await rateLimit(`wa-hook-verify:${ip(c)}`, 30, 60))) return c.text("Too many requests", 429, { "Retry-After": "60" });
  const { verifyChallenge } = await import("@cnote/whatsapp");
  const challenge = verifyChallenge({ mode: c.req.query("hub.mode"), token: c.req.query("hub.verify_token"), challenge: c.req.query("hub.challenge") });
  return challenge === null ? c.text("Forbidden", 403) : c.text(challenge, 200);
});

// POST: verify HMAC on the raw bytes, enqueue, answer fast (Meta retries non-2xx for days).
whatsappWebhook.post("/", async (c) => {
  if (!(await rateLimit(`wa-hook:${ip(c)}`, 600, 60))) return c.text("Too many requests", 429, { "Retry-After": "60" });
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return c.text("Payload too large", 413);
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return c.text("Payload too large", 413);
  const { handleWebhook } = await import("@cnote/whatsapp");
  try {
    const r = await handleWebhook(raw, c.req.raw.headers);
    if (r.status === 401) return c.text("Invalid signature", 401);
    if (r.status === 400) return c.text("Bad request", 400);
    return c.text("OK", 200);
  } catch (err) {
    console.error(`[${c.get("requestId")}] whatsapp webhook enqueue failed`, err);
    return c.text("Unavailable", 503); // queue down: ask Meta to redeliver
  }
});
