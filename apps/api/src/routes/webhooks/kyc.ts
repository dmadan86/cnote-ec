// Video-KYC provider webhook (ADR-003 T2). NOT under /v1, NOT API-key authenticated, NOT in the OpenAPI document:
// authenticity is the HMAC-SHA256 of the raw body in `x-kyc-signature` (KYC_WEBHOOK_SECRET), checked in @cnote/identity.
// The body only identifies the session; the verdict is always re-fetched from the provider (never trusted from the payload).
import { DomainError, rateLimit } from "@cnote/core";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { clientIp } from "@cnote/security/client-ip";

const MAX_BODY_BYTES = 100_000;
const ip = (c: Context): string => clientIp(c.req.raw.headers) ?? "unknown";

export const kycWebhook = new Hono<AppEnv>();

kycWebhook.post("/", async (c) => {
  if (!(await rateLimit(`kyc-hook:${ip(c)}`, 120, 60))) return c.text("Too many requests", 429, { "Retry-After": "60" });
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return c.text("Payload too large", 413);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return c.text("Payload too large", 413);
  const { handleKycWebhook } = await import("@cnote/identity");
  try {
    const r = await handleKycWebhook(raw, Object.fromEntries(c.req.raw.headers.entries()));
    return c.json({ ok: true, status: r.status });
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === "forbidden") return c.text("Invalid signature", 401);
      if (err.code === "validation") return c.text("Bad request", 400);
      if (err.code === "conflict") return c.json({ ok: true, status: "ignored" }); // e.g. expired: nothing to retry
    }
    console.error(`[${c.get("requestId")}] kyc webhook failed`, err);
    return c.text("Unavailable", 503); // ask the provider to redeliver
  }
});
