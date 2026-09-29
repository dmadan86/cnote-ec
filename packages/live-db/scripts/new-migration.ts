// Usage: pnpm --filter @cnote/live-db migrate:new <name>
// Diffs the LIVE database (must be fully migrated) against prisma/schema and writes a new migration,
// stripping drops of raw-SQL objects (see raw-sql-guard.ts). With no existing migrations it diffs from
// empty. Applies it and regenerates the client. NEVER touches the authoring database.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strip } from "./raw-sql-guard";

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) throw new Error("usage: migrate:new <snake_case_name>");

const migrations = path.resolve(import.meta.dirname, "../prisma/migrations");
const hasMigrations = existsSync(migrations) && readdirSync(migrations, { withFileTypes: true }).some((d) => d.isDirectory());
if (hasMigrations) execSync("prisma migrate deploy", { stdio: "inherit" });
const from = hasMigrations ? "--from-config-datasource" : "--from-empty";
const raw = execSync(`prisma migrate diff ${from} --to-schema prisma/schema --script`, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const sql = strip(raw.split("\n").filter((l) => !/^(◇|Loaded Prisma config)/.test(l)).join("\n"));
if (!sql.replace(/--.*$/gm, "").trim() || /^-- This is an empty migration/m.test(sql)) {
  console.log("No schema changes.");
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const dir = path.join(migrations, `${stamp}_${name}`);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "migration.sql"), sql);
console.log(`created ${dir}/migration.sql (add raw SQL for HNSW / generated tsvector by hand on the first migration)`);
execSync("prisma migrate deploy", { stdio: "inherit" });
execSync("prisma generate", { stdio: "inherit" });
