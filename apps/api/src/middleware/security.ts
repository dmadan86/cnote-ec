import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { config } from "../env";

export const security = secureHeaders({
  // JSON API + one self-contained docs page (inline style/script only).
  contentSecurityPolicy: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], scriptSrc: ["'unsafe-inline'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] },
  strictTransportSecurity: "max-age=63072000; includeSubDomains",
});

// Allowlist only: with no API_CORS_ORIGINS no cross-origin browser access is granted (server-to-server use is unaffected).
export const corsAllowlist = cors({
  origin: (origin) => (config.corsOrigins.includes(origin) ? origin : null),
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "X-Request-Id", "Mcp-Session-Id", "Mcp-Protocol-Version"],
  exposeHeaders: ["X-Request-Id", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
  maxAge: 600,
});
