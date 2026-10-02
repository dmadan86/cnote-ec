import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { migrationFiles, strip, violations } from "./raw-sql-guard";

describe("raw-sql-guard", () => {
  it("strips standalone and folded search_tsv DROP DEFAULT and HNSW drops", () => {
    const sql = [
      '-- DropIndex\nDROP INDEX "listings_embedding_hnsw_idx";',
      '-- AlterTable\nALTER TABLE "listings" ALTER COLUMN "search_tsv" DROP DEFAULT;',
      '-- AlterTable\nALTER TABLE "listings" ADD COLUMN     "x" UUID,\nALTER COLUMN "search_tsv" DROP DEFAULT;',
      '-- AlterTable\nALTER TABLE "listings" ALTER COLUMN "search_tsv" DROP DEFAULT,\nADD COLUMN     "y" UUID;',
    ].join("\n\n");
    const out = strip(sql);
    expect(violations(out)).toEqual([]);
    expect(out).toContain('ADD COLUMN     "x" UUID;');
    expect(out).toContain('ADD COLUMN     "y" UUID;');
  });

  // Security audit M5: triggers are raw SQL Prisma cannot model (like the HNSW indexes). `migrate diff` never sees them, so db:new neither
  // drops nor strips them; this pins that and checks the append-only migration covers every guarded table.
  it("leaves trigger DDL alone, and the append-only migration covers every guarded table", () => {
    const trigger = 'CREATE TRIGGER cnote_append_only BEFORE UPDATE OR DELETE ON "t" FOR EACH ROW EXECUTE FUNCTION cnote_append_only_guard();';
    expect(strip(trigger)).toBe(trigger);
    expect(violations(trigger)).toEqual([]);
    const file = migrationFiles().find((f) => f.includes("append_only_triggers"));
    expect(file).toBeDefined();
    const sql = readFileSync(file!, "utf8");
    for (const t of ["admin_audit_log", "credit_ledger", "ad_wallet_ledger", "consents", "ledger_journals", "ledger_lines", "domain_events", "cookie_consent_receipts"]) {
      expect(sql, t).toContain(t);
    }
  });
});
