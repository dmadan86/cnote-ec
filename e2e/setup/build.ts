/**
 * `pnpm test:e2e:build`: prepare the e2e database, then build the buyer web and seller apps against it.
 * The order matters: `next build` runs generateStaticParams / ISR prerendering against the database, so the build must
 * see the seeded data. Env comes from e2e/support/env.ts (dedicated databases, HUMAN_VERIFIER=off, ...).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { e2eEnv } from "../support/env";

const root = path.resolve(__dirname, "../..");
const env = { ...process.env, ...e2eEnv };
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: root, env, stdio: "inherit" });

run("pnpm", ["exec", "tsx", "e2e/setup/prepare-db.ts"]);
// Sequential on purpose: two parallel `next build`s need several GB of RAM.
run("pnpm", ["--filter", "@cnote/web", "build"]);
// The video/map embed block is behind STOREFRONT_EMBEDS_ENABLED (default off); the consent notice is inlined at build time, so the embed
// spec runs against its own build (distDir .next-embeds) and server. Every other spec runs with the flag off, like production.
execFileSync("pnpm", ["--filter", "@cnote/web", "build"], { cwd: root, env: { ...env, STOREFRONT_EMBEDS_ENABLED: "1", NEXT_DIST_DIR: ".next-embeds" }, stdio: "inherit" });
run("pnpm", ["--filter", "@cnote/seller-app", "build"]);
