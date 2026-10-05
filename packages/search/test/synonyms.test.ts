import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkGroups, formatGroupsText, MAX_GROUPS, MAX_TERMS_PER_GROUP, MAX_TERM_LENGTH, mergeVariants, normaliseTerm, parseGroupsText, parseSolr, synonymVariants, toSolrLines } from "../src/synonyms/groups";

describe("normaliseTerm", () => {
  it("folds case, spaces and compatibility forms like normaliseQuery does", () => {
    expect(normaliseTerm("  Cloth   FABRIC ")).toBe("cloth fabric");
    expect(normaliseTerm("कपड़ा")).toBe("कपड़ा".normalize("NFKC"));
    expect(normaliseTerm("ＬＥＤ")).toBe("led"); // full-width letters
  });
});

describe("checkGroups", () => {
  it("accepts a clean multi-script group and folds the terms", () => {
    const r = checkGroups([{ terms: ["Kapda", "कपड़ा", "cloth", " Fabric "], note: " fabric words " }]);
    expect(r.errors).toEqual([]);
    expect(r.groups).toEqual([{ terms: ["kapda", "कपड़ा", "cloth", "fabric"], note: "fabric words" }]);
  });
  it("rejects groups with fewer than two distinct terms, bad characters, long terms and non-lists", () => {
    expect(checkGroups([{ terms: ["only"] }]).errors[0]).toMatch(/at least two/);
    expect(checkGroups([{ terms: ["a", "A"] }]).errors[0]).toMatch(/at least two/);
    expect(checkGroups([{ terms: ["a,b", "c"] }]).errors[0]).toMatch(/not allowed/);
    expect(checkGroups([{ terms: ["a => b", "c"] }]).errors[0]).toMatch(/not allowed/);
    expect(checkGroups([{ terms: ["x".repeat(MAX_TERM_LENGTH + 1), "c"] }]).errors[0]).toMatch(/longer than/);
    expect(checkGroups([{ terms: Array.from({ length: MAX_TERMS_PER_GROUP + 1 }, (_, i) => `t${i}`) }]).errors[0]).toMatch(/at most/);
    expect(checkGroups([{ nope: 1 }]).errors[0]).toMatch(/missing terms/);
    expect(checkGroups([{ terms: [1, "a"] }]).errors[0]).toMatch(/must be text/);
    expect(checkGroups("x").errors[0]).toMatch(/list of groups/);
    expect(checkGroups(Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ terms: [`a${i}`, `b${i}`] }))).errors[0]).toMatch(/At most/);
  });
  it("drops exact duplicate groups regardless of order, keeps overlapping ones", () => {
    const r = checkGroups([{ terms: ["a", "b"] }, { terms: ["B", "A"] }, { terms: ["b", "c"] }]);
    expect(r.groups.map((g) => g.terms)).toEqual([["a", "b"], ["b", "c"]]);
  });
});

describe("editor text format", () => {
  it("round-trips groups and notes, ignores blanks and comments, reads Solr arrows as equivalence", () => {
    const text = "# header\n\nkapda, कपड़ा, cloth   # fabric words\ndabba, dibba => box\n";
    const groups = parseGroupsText(text);
    expect(groups).toEqual([{ terms: ["kapda", "कपड़ा", "cloth"], note: "fabric words" }, { terms: ["dabba", "dibba", "box"] }]);
    expect(parseGroupsText(formatGroupsText(groups))).toEqual(groups);
  });
  it("the shipped Solr starter file parses into valid groups and renders back to Solr lines", () => {
    const groups = parseSolr(readFileSync(new URL("../synonyms/hinglish-b2b.txt", import.meta.url), "utf8"));
    const r = checkGroups(groups);
    expect(r.errors).toEqual([]);
    expect(r.groups.length).toBeGreaterThan(10);
    expect(r.groups.some((g) => g.terms.includes("कपड़ा") && g.terms.includes("fabric"))).toBe(true);
    expect(toSolrLines(r.groups)[0]).toContain(", ");
  });
});

describe("synonymVariants", () => {
  const groups = [{ terms: ["kapda", "कपड़ा", "cloth", "fabric"] }, { terms: ["gatta", "गत्ता", "carton", "corrugated box"] }];
  it("substitutes one matched term at a time, Latin alternatives first", () => {
    expect(synonymVariants("kapda", groups)).toEqual(["cloth", "fabric", "कपड़ा"]);
    expect(synonymVariants("सूती कपड़ा", groups, 10)).toEqual(["सूती kapda", "सूती cloth", "सूती fabric"]);
  });
  it("matches phrases and Latin plurals, whole words only", () => {
    expect(synonymVariants("corrugated box supplier", groups)).toEqual(["gatta supplier", "carton supplier", "गत्ता supplier"]);
    expect(synonymVariants("cloths", groups)[0]).toBe("kapda");
    expect(synonymVariants("clothing", groups)).toEqual([]); // "cloth" must not match inside "clothing"
  });
  it("is capped, deterministic and never returns the query itself", () => {
    expect(synonymVariants("kapda", groups, 1)).toEqual(["cloth"]);
    expect(synonymVariants("kapda", groups, 0)).toEqual([]);
    expect(synonymVariants("kapda", [{ terms: ["kapda", "kapda "] }])).toEqual([]);
    expect(synonymVariants("", groups)).toEqual([]);
    expect(synonymVariants("kapda", [])).toEqual([]);
    expect(synonymVariants("kapda", groups)).toEqual(synonymVariants("kapda", groups));
  });
  it("walks several groups in dictionary order", () => {
    expect(synonymVariants("kapda gatta", groups, 10)).toEqual(["cloth gatta", "fabric gatta", "कपड़ा gatta", "kapda carton", "kapda corrugated box", "kapda गत्ता"]);
  });
});

describe("mergeVariants", () => {
  it("puts curated variants first, drops duplicates and empties, caps", () => {
    expect(mergeVariants(["a", "b"], ["b", "", "c", "d"], 4)).toEqual(["a", "b", "c", "d"]);
    expect(mergeVariants(["a", "b"], ["c"], 2)).toEqual(["a", "b"]);
  });
});
