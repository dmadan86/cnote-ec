import { OpenAPIHono } from "@hono/zod-openapi";
import { API_VERSION, config } from "./env";
import { docsHtml } from "./docs-page";
import { toErrorResponse } from "./lib/errors";
import { handleMcp } from "./mcp/server";
import { authenticate } from "./middleware/auth";
import { requestId } from "./middleware/request-id";
import { corsAllowlist, security } from "./middleware/security";
import { validationHook } from "./routes/helpers";
import { v1 } from "./routes/v1";
import { kycWebhook } from "./routes/webhooks/kyc";
import { paymentsWebhook } from "./routes/webhooks/payments";
import { whatsappWebhook } from "./routes/webhooks/whatsapp";
import { SCOPE_DOCS } from "./scopes";
import type { AppEnv } from "./types";

export interface HealthCheck { (): Promise<{ postgres: boolean; redis: boolean }> }

const description = (): string => `
Public REST API for the cnote B2B marketplace for Indian MSMEs. An MCP server exposing the same capabilities is available at \`${config.publicUrl}/mcp\`.

## Authentication
Create a personal API key in the web app (Account > Developers) or the seller portal, then send it on every request:

\`Authorization: Bearer ck_live_...\`

Keys are shown once, can expire (1 day to never) and are revoked instantly. A missing/invalid key returns 401 with a \`WWW-Authenticate\` header.

## Scopes
Each operation lists its scope in \`x-required-scope\`. A \`:write\` scope implies the matching \`:read\`. Missing scope returns 403.

${Object.entries(SCOPE_DOCS).map(([s, d]) => `- \`${s}\`: ${d}`).join("\n")}

## Rate limits
${config.ratePerMinute} requests per minute per key (REST and MCP combined). Exceeding it returns 429 with a \`Retry-After\` header (seconds). Some actions have tighter limits (e.g. chat messages).

## Conventions
- Money is integer paise; every money-bearing object carries \`currency: "INR"\`.
- Dates are ISO 8601. Lists use cursor pagination: \`?cursor=&limit=\` (limit up to 100); pass \`nextCursor\` back until it is null.
- Errors: \`{ "error": { "code", "message", "requestId", "issues"? } }\`. Quote \`requestId\` (also the \`X-Request-Id\` header) when contacting support.

## Business rules
- Search ranks by relevance x seller trust, never by paid tier; \`sponsored\` is always false.
- Enquiries are intent-scored and matched exclusively to at most N sellers; buyer contact is revealed to a seller only after accepting.
- Accepting a lead consumes 1 credit.
- Listings and reviews are moderated: only published + approved listings and approved reviews are public.
- A key acts only within its own person/business; keys not bound to a business cannot use buyer/seller endpoints.
`.trim();

export function createApp(deps: { health?: HealthCheck; onServerError?: (err: unknown, requestId: string) => void } = {}) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.use("*", requestId);
  app.use("*", security);
  app.use("*", corsAllowlist);

  app.onError((err, c) => {
    const { status, body, headers } = toErrorResponse(err, c.get("requestId"));
    if (status === 500) {
      console.error(`[${c.get("requestId")}]`, err);
      deps.onServerError?.(err, c.get("requestId"));
    }
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    return c.json(body, status);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such route", requestId: c.get("requestId") } }, 404));

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http", scheme: "bearer", bearerFormat: "ck_live_…", description: "Personal API key created in your account. `Authorization: Bearer ck_live_...`",
  });

  app.get("/health", async (c) => {
    const check = deps.health ?? defaultHealth;
    const r = await check().catch(() => ({ postgres: false, redis: false }));
    const ok = r.postgres && r.redis;
    return c.json({ status: ok ? "ok" : "degraded", ...r }, ok ? 200 : 503);
  });

  // Provider webhooks: signature-authenticated, outside /v1 and the OpenAPI document.
  app.route("/webhooks/whatsapp", whatsappWebhook);
  app.route("/webhooks/kyc", kycWebhook);
  app.route("/webhooks/payments", paymentsWebhook);

  app.use("/v1/*", authenticate("rest"));
  app.route("/v1", v1);

  // MCP: same bearer auth (kind "mcp"), same scopes.
  app.use("/mcp", authenticate("mcp"));
  app.all("/mcp", handleMcp);

  app.doc31("/openapi.json", () => openApiConfig());
  app.get("/docs", (c) => c.html(docsHtml(config.publicUrl)));
  app.get("/", (c) => c.redirect("/docs"));

  return app;
}

export const openApiConfig = () => ({
  openapi: "3.1.0",
  info: {
    title: "cnote API", version: API_VERSION, description: description(),
    contact: { name: "cnote developers" },
  },
  servers: [{ url: config.publicUrl }],
  tags: ["Account", "Catalogue", "Search", "Seller listings", "Bulk import and export", "Seller leads", "Seller billing", "Enquiries", "Conversations", "Wishlist", "Reviews"].map((name) => ({ name })),
});

async function defaultHealth() {
  // Lazy imports keep app.ts loadable in tests without a DB.
  const [{ prisma }, { redis }] = await Promise.all([import("@cnote/db"), import("@cnote/core")]);
  const [postgres, redisOk] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true, () => false),
    redis.ping().then((r) => r === "PONG", () => false),
  ]);
  return { postgres, redis: redisOk };
}
