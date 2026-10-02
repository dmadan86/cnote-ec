// Credit partner webhooks (ADR-019; mock / nbfc_partner). Same contract as the payment webhooks: NOT under /v1,
// NOT API-key authenticated, NOT in OpenAPI; authenticity is the partner's signature over the RAW body. Idempotent per
// partner event id; infra errors return 503 so the partner retries.
import { DomainError, rateLimit } from "@cnote/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { readBodyCapped } from "../../lib/body";
import { clientIp } from "@cnote/security/client-ip";

const MAX_BODY_BYTES = 256_000;
const ip = (c: Context): string => clientIp(c.req.raw.headers) ?? "unknown";

export const creditWebhook = new Hono<AppEnv>();

creditWebhook.post("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!(await rateLimit(`credit-hook:${ip(c)}`, 600, 60))) return c.text("Too many requests", 429, { "Retry-After": "60" });
  const raw = await readBodyCapped(c.req.raw, MAX_BODY_BYTES);
  if (!raw) return c.text("Payload too large", 413);
  const { handleCreditWebhook } = await import("@cnote/credit");
  try {
    const r = await handleCreditWebhook(provider, raw, c.req.raw.headers);
    return c.json({ status: r.status }, 200);
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === "not_found") return c.text("Not found", 404);
      if (err.code === "unauthenticated") return c.text("Invalid signature", 401);
      if (err.code === "validation" || err.code === "conflict") return c.text("Bad request", 400);
    }
    console.error(`[${c.get("requestId")}] credit webhook failed`, err);
    return c.text("Unavailable", 503);
  }
});
