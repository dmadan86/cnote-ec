import { describe, expect, it } from "vitest";
import { strip, violations } from "./raw-sql-guard";

describe("live raw-sql-guard", () => {
  it("strips bogus drops of the HNSW index and tsvector default", () => {
    const sql = `-- DropIndex\nDROP INDEX "live_listings_embedding_hnsw_idx";\n\n-- AlterTable\nALTER TABLE "live_listings" ALTER COLUMN "search_tsv" DROP DEFAULT;\n`;
    const out = strip(sql);
    expect(violations(out)).toEqual([]);
    expect(out).not.toContain("hnsw");
  });
  it("flags leftovers", () => {
    expect(violations('DROP INDEX "live_listings_embedding_hnsw_idx";').length).toBe(1);
  });
});
