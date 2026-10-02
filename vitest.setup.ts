// Loads local env for package tests (CI provides env directly), then points every DB/Redis-backed
// test at ISOLATED test stores so tests can never leak rows or cache keys into the dev databases:
//   Postgres  <db>_test  (authoring) and <live_db>_test (LIVE read DB) — or TEST_DATABASE_URL / TEST_LIVE_DATABASE_URL
//   Redis     logical DB 1 — or TEST_REDIS_URL
// Prepare them once with `pnpm db:test:prepare`.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(import.meta.dirname, ".env.local"), quiet: true });

// Deterministic, test-only crypto keys when neither .env.local nor CI provides them (production-mode tests need a
// keyring). Not secrets: they only ever encrypt throwaway test rows.
if (!process.env.FIELD_ENCRYPTION_KEYS) {
  process.env.FIELD_ENCRYPTION_KEYS = `test1:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.FIELD_ENCRYPTION_ACTIVE_KID = "test1";
}
// Unit tests send cf-connecting-ip to key rate limits per test; clientIp honours it only with TRUST_CLOUDFLARE=1 (client-ip.test.ts passes env explicitly).
process.env.TRUST_CLOUDFLARE ||= "1";
// dedicated, test-only domain-check secret (the app refuses to start the probe without one; never reuses JWT_SECRET)
process.env.DOMAIN_CHECK_SECRET ||= "test-only-domain-check-secret-not-for-prod";
process.env.BLIND_INDEX_KEY ||= Buffer.alloc(32, 9).toString("base64");

function testUrl(url: string | undefined, fallback: string): string {
  const u = new URL(url ?? fallback);
  if (!u.pathname.endsWith("_test")) u.pathname = `${u.pathname}_test`;
  return u.toString();
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? testUrl(process.env.DATABASE_URL, "postgres://cnote:cnote@localhost:5432/cnote");
process.env.LIVE_DATABASE_URL =
  process.env.TEST_LIVE_DATABASE_URL ?? testUrl(process.env.LIVE_DATABASE_URL, "postgres://cnote:cnote@localhost:5432/cnote_live");
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;
else {
  const r = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  r.pathname = "/1";
  process.env.REDIS_URL = r.toString();
}
