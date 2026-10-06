// Staff relevance judgements: DB-backed (isolated cnote_test) + the shared file format.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { parseRelevanceFile, productKeyOf, queryKeyOf } from "../src/relevance/format";
import { deleteJudgement, exportJudgements, judgedQueries, listJudgements, recordJudgement } from "../src/relevance/judgements";

const staff = randomUUID();
const tag = randomUUID().slice(0, 8);
const wipe = () => prisma.searchJudgement.deleteMany({ where: { judgedByStaffId: staff } });
beforeEach(wipe);
afterAll(wipe);

const base = (over: Record<string, unknown> = {}) => ({ query: `kapda ${tag}`, lang: "hinglish", listingId: randomUUID(), listingTitle: "Cotton Fabric Bulk Roll", categorySlug: "textiles", grade: 3, backend: "postgres", staffId: staff, ...over });

describe("keys", () => {
  it("descriptor keys are title slugs and query keys are folded", () => {
    expect(productKeyOf(" Cotton Fabric — Bulk Roll (44\") ")).toBe("cotton-fabric-bulk-roll-44");
    expect(productKeyOf("कपड़ा थान")).toBe("कपड़ा-थान");
    expect(queryKeyOf("  Kapda   CHAHIYE ")).toBe("kapda chahiye");
  });
});

describe("recordJudgement", () => {
  it("upserts one grade per (query, product): re-judging overwrites, folded queries collide", async () => {
    await recordJudgement(base());
    const again = await recordJudgement(base({ query: `  KAPDA   ${tag} `, grade: 1 }));
    expect(again.grade).toBe(1);
    expect(await prisma.searchJudgement.count({ where: { judgedByStaffId: staff } })).toBe(1);
    await recordJudgement(base({ listingTitle: "Plain Cotton T-Shirts", grade: 2 }));
    expect((await listJudgements({ query: `kapda ${tag}` })).map((j) => [j.productKey, j.grade]).sort()).toEqual([["cotton-fabric-bulk-roll", 1], ["plain-cotton-t-shirts", 2]]);
  });
  it("validates grade, query, title and language", async () => {
    for (const bad of [{ grade: 4 }, { grade: -1 }, { grade: 1.5 }, { query: "  " }, { query: "x".repeat(501) }, { listingTitle: "!!!" }, { lang: "EN us" }]) {
      await expect(recordJudgement(base(bad))).rejects.toMatchObject({ code: "validation" });
    }
  });
});

describe("listing, deleting, exporting", () => {
  it("lists judged queries with counts and deletes by id", async () => {
    const a = await recordJudgement(base());
    await recordJudgement(base({ listingTitle: "Banarasi Silk Saree", grade: 1 }));
    const qs = (await judgedQueries(500)).filter((q) => q.query === `kapda ${tag}`);
    expect(qs).toEqual([{ query: `kapda ${tag}`, lang: "hinglish", judged: 2 }]);
    expect(await deleteJudgement(a.id)).toBe(true);
    expect(await deleteJudgement(a.id)).toBe(false);
    expect(await judgedQueries()).toBeInstanceOf(Array);
  });

  it("exports a file the shared parser accepts, keyed by descriptor with a product table", async () => {
    await recordJudgement(base());
    await recordJudgement(base({ listingTitle: "Banarasi Silk Saree", grade: 0 }));
    await recordJudgement(base({ query: `chawal ${tag}`, listingTitle: "Basmati Rice 25kg Bag", categorySlug: null }));
    const exported = await exportJudgements();
    const mine = { ...exported, queries: exported.queries.filter((q) => q.query.endsWith(tag)) };
    const file = parseRelevanceFile(mine);
    const kapda = file.queries.find((q) => q.query.startsWith("kapda"))!;
    expect(kapda.relevant).toEqual({ "cotton-fabric-bulk-roll": 3, "banarasi-silk-saree": 0 });
    expect(file.products!["basmati-rice-25kg-bag"]).toEqual({ title: "Basmati Rice 25kg Bag", categorySlug: null });
  });
});

describe("parseRelevanceFile", () => {
  const q = (id: string, rel: Record<string, number> = { a: 3 }) => ({ id, query: "x", lang: "en", relevant: rel });
  it("rejects duplicate ids, duplicate corpus keys, unknown graded keys and out-of-range grades", () => {
    const item = (key: string) => ({ key, title: key + " item", category: { slug: "c", name: "C" } });
    expect(() => parseRelevanceFile({ version: 1, queries: [q("1"), q("1")] })).toThrow(/duplicate query id/);
    expect(() => parseRelevanceFile({ version: 1, corpus: [item("a"), item("a")], queries: [q("1")] })).toThrow(/duplicate corpus key/);
    expect(() => parseRelevanceFile({ version: 1, corpus: [item("a")], queries: [q("1", { zzz: 2 })] })).toThrow(/unknown corpus key/);
    expect(() => parseRelevanceFile({ version: 1, queries: [q("1", { a: 4 })] })).toThrow();
    expect(parseRelevanceFile({ version: 1, corpus: [item("a")], queries: [q("1")] }).queries).toHaveLength(1);
  });
});
