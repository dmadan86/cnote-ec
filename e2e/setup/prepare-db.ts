/**
 * Prepares the isolated e2e stores: create databases if missing, migrate both schemas, seed, project the seeded
 * listings into the live read DB, and flush the e2e Redis logical DB (rate-limit counters, caches).
 *
 *   pnpm test:e2e:prepare        one-shot (also run as part of `pnpm test:e2e:build`)
 *   tsx e2e/setup/prepare-db.ts --serve
 *                                same, then keep a tiny HTTP server open on E2E_DB_READY_PORT. playwright.config.ts
 *                                uses this as its FIRST webServer entry: Playwright starts webServer entries in
 *                                order and waits for each URL, so the app servers only start once the data is ready
 *                                (an ISR page rendered against an empty database would otherwise be cached empty).
 *
 * Idempotent: the seed upserts on stable keys, so re-running against an existing database is safe and fast.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { DB_READY_PORT, e2eEnv } from "../support/env";

const root = path.resolve(__dirname, "../..");
const env = { ...process.env, ...e2eEnv };
const requireFrom = (pkgDir: string) => createRequire(path.join(root, pkgDir, "package.json"));

function run(cmd: string, args: string[]) {
  console.log(`[e2e] $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, env, stdio: "inherit" });
}

async function ensureDatabase(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`unsafe database name ${name}`);
  if (!/_e2e$/.test(name)) throw new Error(`refusing to touch database "${name}": e2e databases must end in _e2e`);
  const { Client } = requireFrom("packages/db")("pg") as { Client: new (o: { connectionString: string }) => { connect(): Promise<void>; end(): Promise<void>; query(q: string, p?: unknown[]): Promise<{ rowCount: number | null }> } };
  u.pathname = "/postgres";
  const admin = new Client({ connectionString: u.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) {
      console.log(`[e2e] creating database ${name}`);
      await admin.query(`create database "${name}"`);
    }
  } finally {
    await admin.end();
  }
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("create extension if not exists vector");
  } catch (e) {
    console.warn(`[e2e] could not create the vector extension in ${name} (fine if the migration does): ${(e as Error).message}`);
  } finally {
    await c.end();
  }
}

async function flushRedis() {
  const url = new URL(e2eEnv.REDIS_URL);
  if (!/^\/[1-9]\d*$/.test(url.pathname)) throw new Error(`refusing to flush Redis "${url.pathname || "/0"}": e2e must use a non-zero logical DB`);
  const Redis = (requireFrom("packages/core")("ioredis") as { default?: unknown }).default ?? requireFrom("packages/core")("ioredis");
  const r = new (Redis as new (u: string) => { flushdb(): Promise<unknown>; quit(): Promise<unknown> })(e2eEnv.REDIS_URL);
  await r.flushdb();
  await r.quit();
}

async function main() {
  await ensureDatabase(e2eEnv.DATABASE_URL);
  await ensureDatabase(e2eEnv.LIVE_DATABASE_URL);
  run("pnpm", ["--filter", "@cnote/db", "exec", "prisma", "migrate", "deploy"]);
  run("pnpm", ["--filter", "@cnote/live-db", "migrate:deploy"]);
  // Not `pnpm db:seed`: that script passes --env-file=.env.local, which does not exist in CI.
  run("pnpm", ["--filter", "@cnote/worker", "exec", "tsx", path.join(root, "apps/worker/src/seed.ts")]);
  run("pnpm", ["--filter", "@cnote/worker", "exec", "tsx", path.join(root, "e2e/setup/backfill-live.ts")]);
  await flushRedis();
  console.log("[e2e] database ready");

  if (process.argv.includes("--serve")) {
    createServer((_req, res) => res.end("ready")).listen(Number(DB_READY_PORT), () => console.log(`[e2e] ready on :${DB_READY_PORT}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
