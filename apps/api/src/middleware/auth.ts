import { DomainError, rateLimit } from "@cnote/core";
import { hasScope, verifyApiKey, type Scope } from "@cnote/developer";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "../env";
import { ApiError } from "../lib/errors";
import type { AppEnv } from "../types";

function clientIp(c: Context): string | null {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // not running on the node server (tests)
  }
}

const unauthorized = (message: string, error: "invalid_request" | "invalid_token") =>
  new ApiError(401, "unauthenticated", message, { "WWW-Authenticate": `Bearer realm="cnote-api", error="${error}"` });

/** Bearer `ck_…` → principal on context. `kind` feeds key-usage analytics. */
export const authenticate = (kind: "rest" | "mcp"): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw unauthorized("Missing API key. Send `Authorization: Bearer ck_live_…`.", "invalid_request");
  const secret = m[1]!;
  if (!secret.startsWith("ck_")) throw unauthorized("Malformed API key.", "invalid_token");
  const principal = await verifyApiKey(secret, { ip: clientIp(c), kind });
  if (!principal) throw unauthorized("Invalid, expired or revoked API key.", "invalid_token");

  const limit = config.ratePerMinute;
  let allowed = true;
  try {
    allowed = await rateLimit(`api:${principal.keyId}`, limit, 60);
  } catch {
    // Redis hiccup: fail open rather than take the API down.
  }
  c.header("X-RateLimit-Limit", String(limit));
  if (!allowed) {
    const retryAfterSeconds = 60 - (Math.floor(Date.now() / 1000) % 60);
    throw new DomainError("rate_limited", `Rate limit of ${limit} requests/minute exceeded for this key.`, { retryAfterSeconds });
  }
  c.set("principal", principal);
  await next();
};

/** 403 naming the missing scope. `:write` implies `:read` (see hasScope). */
export const requireScope = (scope: Scope): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!hasScope(c.get("principal"), scope)) {
    throw new ApiError(403, "insufficient_scope", `This API key lacks the required scope: ${scope}.`, {
      "WWW-Authenticate": `Bearer realm="cnote-api", error="insufficient_scope", scope="${scope}"`,
    });
  }
  await next();
};
