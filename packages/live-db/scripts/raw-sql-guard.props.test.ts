import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, toVectorLiteral } from "../src/vector";
import { FORBIDDEN, migrationFiles, strip, violations } from "./raw-sql-guard";

const HNSW = '-- DropIndex\nDROP INDEX "live_listings_embedding_hnsw_idx";';
const TSV = '-- AlterTable\nALTER TABLE "live_listings" ALTER COLUMN "search_tsv" DROP DEFAULT;';

describe("raw-sql-guard: committed migrations", () => {
  it("there are migrations and none drops HNSW indexes or the search_tsv default", () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(violations(readFileSync(f, "utf8")), f).toEqual([]);
  });
});

describe("raw-sql-guard: strip", () => {
  it("strips the live HNSW index drop", () => {
    const out = strip(`${HNSW}\n`);
    expect(out).not.toContain("hnsw");
    expect(violations(out)).toEqual([]);
  });

  it("keeps unrelated DDL byte-for-byte", () => {
    const keep = '-- CreateTable\nCREATE TABLE "x" ("id" UUID NOT NULL);\n\n-- DropIndex\nDROP INDEX "other_idx";\n';
    expect(strip(keep)).toBe(keep);
    expect(strip(`${HNSW}\n\n${keep}`).trim()).toBe(keep.trim());
  });

  it("does not strip an HNSW drop for a different table (guard stays precise)", () => {
    const other = '-- DropIndex\nDROP INDEX "listings_embedding_hnsw_idx";'; // authoring-DB name must not be touched here
    expect(strip(other)).toBe(other);
  });

  it("collapses runs of blank lines left behind", () => {
    expect(strip(`a;\n\n\n\n\nb;`)).toBe("a;\n\nb;");
  });

  it("is idempotent and never leaves a violation, for arbitrary surrounding DDL", () => {
    const stmt = fc.constantFrom(HNSW, TSV, 'ALTER TABLE "t" ADD COLUMN "c" INT;', 'CREATE INDEX "i" ON "t"("c");');
    fc.assert(
      fc.property(fc.array(stmt, { maxLength: 12 }), (parts) => {
        const sql = parts.join("\n\n");
        const once = strip(sql);
        expect(strip(once)).toBe(once);
        expect(violations(once)).toEqual([]);
      }),
      { seed: 7, numRuns: 200 },
    );
  });

  it("preserves every non-forbidden statement, in order", () => {
    const keepers = ['ALTER TABLE "t" ADD COLUMN "c" INT;', 'CREATE INDEX "i" ON "t"("c");', 'DROP TABLE "z";'];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...keepers, HNSW, TSV), { maxLength: 15 }), (parts) => {
        const out = strip(parts.join("\n\n"));
        const remaining = out.split("\n\n").map((s) => s.trim()).filter(Boolean);
        expect(remaining).toEqual(parts.filter((p) => keepers.includes(p)));
      }),
      { seed: 11, numRuns: 200 },
    );
  });
});

describe("raw-sql-guard: violations", () => {
  it("flags each forbidden pattern separately and reports nothing for clean SQL", () => {
    expect(violations('DROP INDEX "live_listings_embedding_hnsw_idx"')).toHaveLength(1);
    expect(violations('ALTER TABLE "live_listings" ALTER COLUMN "search_tsv" DROP DEFAULT')).toHaveLength(1);
    expect(violations('CREATE INDEX "live_listings_embedding_hnsw_idx" ON x')).toEqual([]);
    expect(violations("")).toEqual([]);
  });
  it("pattern list has anchored strip patterns and unanchored detect patterns", () => {
    expect(FORBIDDEN).toHaveLength(4);
  });
});

describe("toVectorLiteral", () => {
  it("serialises exactly EMBEDDING_DIM numbers", () => {
    const v = Array.from({ length: EMBEDDING_DIM }, (_, i) => i / 10);
    const lit = toVectorLiteral(v);
    expect(lit.startsWith("[")).toBe(true);
    expect(lit.endsWith("]")).toBe(true);
    expect(JSON.parse(lit)).toEqual(v);
  });
  it("rejects wrong dimensions (too short, too long, empty)", () => {
    for (const n of [0, 1, EMBEDDING_DIM - 1, EMBEDDING_DIM + 1]) expect(() => toVectorLiteral(new Array(n).fill(0))).toThrow(/256-dim/);
  });
});
