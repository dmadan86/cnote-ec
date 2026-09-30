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
run("pnpm", ["--filter", "@cnote/seller-app", "build"]);
