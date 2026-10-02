// Payment gateway webhooks (Razorpay, Cashfree; the mock provider only outside production). NOT under /v1, NOT API-key
// authenticated, NOT in OpenAPI: authenticity is the provider's HMAC over the RAW body (docs/design/payments-and-invoicing.md).
// Idempotent (PaymentWebhookEvent unique per provider+event), answers fast; infra errors return 503 so the provider retries.
import { rateLimit } from "@cnote/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { readBodyCapped } from "../../lib/body";
import { clientIp } from "@cnote/security/client-ip";

const MAX_BODY_BYTES = 256_000;
const ip = (c: Context): string => clientIp(c.req.raw.headers) ?? "unknown";

export const paymentsWebhook = new Hono<AppEnv>();

paymentsWebhook.post("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!["razorpay", "cashfree", "mock"].includes(provider)) return c.text("Not found", 404);
  if (!(await rateLimit(`pay-hook:${ip(c)}`, 600, 60))) return c.text("Too many requests", 429, { "Retry-After": "60" });
  const raw = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
  if (!raw) return c.text("Payload too large", 413);
  const { handlePaymentWebhook } = await import("@cnote/billing");
  try {
    const r = await handlePaymentWebhook(provider, raw, c.req.raw.headers);
    if (r.status === 401) return c.text("Invalid signature", 401);
    if (r.status === 400) return c.text("Bad request", 400);
    return c.text("OK", 200);
  } catch (err) {
    console.error(`[${c.get("requestId")}] payment webhook failed`, err);
    return c.text("Unavailable", 503);
  }
});
