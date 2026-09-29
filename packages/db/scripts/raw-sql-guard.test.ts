import { describe, expect, it } from "vitest";
import { strip, violations } from "./raw-sql-guard";

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
});
