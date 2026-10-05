/**
 * Single source of truth for the e2e environment. Imported by playwright.config.ts (to configure the web servers)
 * and by e2e/setup/prepare-db.ts (to migrate + seed). Everything is overridable from the shell / CI.
 *
 * The suites NEVER touch the dev databases: they use dedicated `cnote_e2e` / `cnote_live_e2e` databases and Redis
 * logical DB 2 (unit tests use DB 1, dev uses DB 0). Postgres/Redis themselves come from brew services or docker.
 */
const pgBase = process.env.E2E_PG_BASE ?? "postgres://cnote:cnote@localhost:5432";
const redisBase = process.env.E2E_REDIS_BASE ?? "redis://localhost:6379";

export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const SELLER_URL = process.env.E2E_SELLER_URL ?? "http://localhost:3002";
/** A second buyer-web build + server with STOREFRONT_EMBEDS_ENABLED=1, used only by the storefront embed spec (the consent notice is inlined at build time). */
export const EMBEDS_URL = process.env.E2E_EMBEDS_URL ?? "http://localhost:3006";
export const EMBEDS_PORT = new URL(EMBEDS_URL).port || "3006";
export const WEB_PORT = new URL(WEB_URL).port || "3000";
export const SELLER_PORT = new URL(SELLER_URL).port || "3002";
/** Tiny keep-alive HTTP server that the first `webServer` entry opens once the database is migrated + seeded. */
export const DB_READY_PORT = process.env.E2E_DB_READY_PORT ?? "3999";

/** Random-looking, 32-byte, non-secret keys (production mode rejects placeholder-looking values). */
const FIELD_KEY = Buffer.from("e2e-field-key-0123456789abcdef!!").toString("base64");
const BLIND_KEY = Buffer.from("e2e-blind-index-key-0123456789ab").toString("base64");

/** Env shared by prepare-db, the build and the servers. Order matters: explicit shell values win. */
export const e2eEnv: Record<string, string> = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? `${pgBase}/cnote_e2e`,
  LIVE_DATABASE_URL: process.env.E2E_LIVE_DATABASE_URL ?? `${pgBase}/cnote_live_e2e`,
  REDIS_URL: process.env.E2E_REDIS_URL ?? `${redisBase}/2`,
  // Bot check (Cloudflare Turnstile) is bypassed explicitly: see packages/security/src/human.ts (devAdapter).
  HUMAN_VERIFIER: "off",
  AI_PROVIDER: "heuristic",
  QUEUE_DRIVER: "memory",
  OTP_DEV_ECHO: "true",
  // The specs send a per-context cf-connecting-ip (see fixtures.ts) so rate limits do not collide; clientIp honours it only with this flag.
  TRUST_CLOUDFLARE: "1",
  // The servers run NODE_ENV=production, where startup validation (packages/security/src/secrets.ts) rejects the OTP echo and requires the
  // webhook secret of every enabled provider (escrow is on below). The OTP echo opt-out is for e2e/dev only: never set it on a real deployment.
  ALLOW_OTP_ECHO_IN_PRODUCTION: "1",
  ESCROW_WEBHOOK_SECRET: "e2e-escrow-webhook-secret-not-for-production-0123456789",
  // Lets a spec purge the web ISR cache the way the cache worker would (POST /api/revalidate), e.g. e2e/a11y/product-qa.spec.ts.
  REVALIDATE_SECRET: "e2e-revalidate-secret-not-for-production",
  JWT_SECRET: "q7Xk2mP9vLr4Tn8Bw3Zc6Hd1Fy5Js0Ag-e2e-signing-key",
  FIELD_ENCRYPTION_KEYS: `e2e1:${FIELD_KEY}`,
  FIELD_ENCRYPTION_ACTIVE_KID: "e2e1",
  BLIND_INDEX_KEY: BLIND_KEY,
  APP_URL: WEB_URL,
  SELLER_APP_URL: SELLER_URL,
  ADMIN_APP_URL: "http://localhost:3001",
  MEDIA_DRIVER: "local",
  MEDIA_DIR: ".data/media-e2e",
  // Feature flags stay at their defaults (off). A spec that needs one must set it here on purpose and say why.
  // Phase-2/3 buyer screens (order escrow panel, dispute pages, agent mandates) render only with these on; the a11y gate
  // (e2e/a11y/remaining-screens.spec.ts) has to scan them. Nothing here moves money: the escrow partner is the mock.
  ESCROW_ENABLED: "true",
  ESCROW_PARTNER: "mock",
  DISPUTES_ENABLED: "true",
  A2A_ENABLED: "true",
  // Sample requests (docs/design/samples.md): the buyer samples screens and the product-page request dialog render only with this on (a11y gate: e2e/a11y/samples.spec.ts). Nothing here moves money.
  SAMPLES_ENABLED: "true",
  // The servers run in production mode, where the mock payment gateway is refused. The seller billing spec cancels a seeded
  // annual plan and needs the mock provider's refund to succeed (ADR-005); nothing here charges money.
  PAYMENTS_ALLOW_MOCK_IN_PRODUCTION: "1",
  SENTRY_DSN: "",
  NEXT_PUBLIC_SENTRY_DSN: "",
  NEXT_PUBLIC_CLARITY_PROJECT_ID: "",
  GOOGLE_CLIENT_ID: "",
  NEXT_TELEMETRY_DISABLED: "1",
  // The e2e servers run NODE_ENV=production, where missing legal entity details are fatal. CI sets them (.github/workflows/ci.yml);
  // a local run without them opts out explicitly instead.
  ...(process.env.PLATFORM_LEGAL_NAME ? {} : { LEGAL_ENTITY_STRICT: "false" }),
};

/** Seeded demo accounts (apps/worker/src/seed.ts). */
export const DEMO = {
  buyer: { email: "buyer-demo@example.com", password: "DemoBuyer#2026" },
  seller: { email: "seller-demo@example.com", password: "DemoSeller#2026" },
};
