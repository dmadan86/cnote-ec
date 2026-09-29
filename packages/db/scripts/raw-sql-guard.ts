// Prisma cannot model pgvector HNSW indexes or the generated `search_tsv` column, so every
// `prisma migrate dev` diff tries to drop them. `new-migration.ts` strips those statements
// automatically; `check` fails CI if one slips into a committed migration.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(import.meta.dirname, "../prisma/migrations");

export const FORBIDDEN: RegExp[] = [
  /^-- DropIndex\s*\nDROP INDEX "(listings|enquiries)_embedding_hnsw_idx";\s*$/gm,
  /^-- AlterTable\s*\nALTER TABLE "listings" ALTER COLUMN "search_tsv" DROP DEFAULT;\s*$/gm,
  /DROP INDEX "(listings|enquiries)_embedding_hnsw_idx"/,
  /ALTER COLUMN "search_tsv" DROP DEFAULT/,
];

export function strip(sql: string): string {
  let out = sql;
  for (const re of FORBIDDEN.slice(0, 2)) out = out.replace(re, "");
  return out.replace(/\n{3,}/g, "\n\n");
}

export function violations(sql: string): string[] {
  return FORBIDDEN.slice(2).flatMap((re) => (re.test(sql) ? [re.source] : []));
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(MIGRATIONS, d.name, "migration.sql"));
}

if (process.argv[2] === "check") {
  const bad = migrationFiles().flatMap((f) => violations(readFileSync(f, "utf8")).map((v) => `${f}: ${v}`));
  if (bad.length) {
    console.error("Migrations drop raw-SQL objects Prisma cannot model:\n" + bad.join("\n"));
    process.exit(1);
  }
  console.log("raw-sql-guard: ok");
} else if (process.argv[2] === "strip") {
  const file = process.argv[3]!;
  writeFileSync(file, strip(readFileSync(file, "utf8")));
}
