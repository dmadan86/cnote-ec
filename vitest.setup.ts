// Loads local env for package tests (CI provides env directly), then points every DB/Redis-backed
// test at ISOLATED test stores so tests can never leak rows or cache keys into the dev databases:
//   Postgres  <db>_test  (authoring) and <live_db>_test (LIVE read DB) — or TEST_DATABASE_URL / TEST_LIVE_DATABASE_URL
//   Redis     logical DB 1 — or TEST_REDIS_URL
// Prepare them once with `pnpm db:test:prepare`.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(import.meta.dirname, ".env.local"), quiet: true });

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
