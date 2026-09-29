// Usage: pnpm db:new <name>
// Diffs the local database (must be fully migrated) against prisma/schema, writes a new migration,
// strips drops of raw-SQL objects Prisma cannot model (see raw-sql-guard.ts), applies it and
// regenerates the client. Non-interactive, so it works for agents and CI alike.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strip } from "./raw-sql-guard";

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) throw new Error("usage: pnpm db:new <snake_case_name>");

execSync("prisma migrate deploy", { stdio: "inherit" });
const raw = execSync("prisma migrate diff --from-config-datasource --to-schema prisma/schema --script", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const sql = strip(raw.split("\n").filter((l) => !/^(◇|Loaded Prisma config)/.test(l)).join("\n"));
if (!sql.replace(/--.*$/gm, "").trim() || /^-- This is an empty migration/m.test(sql)) {
  console.log("No schema changes.");
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const dir = path.resolve(import.meta.dirname, "../prisma/migrations", `${stamp}_${name}`);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "migration.sql"), sql);
console.log(`created ${dir}/migration.sql`);
execSync("prisma migrate deploy", { stdio: "inherit" });
execSync("prisma generate", { stdio: "inherit" });
