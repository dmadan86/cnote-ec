import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_UNITS, CERTIFICATE_FIELD, HSN_RE, PACKAGING_BENGALURU, PLAYBOOKS, PlaybookSchema, TRADE_UNITS, categoryNeedsCertificate, checkPlaybookConstraints,
  getPlaybook, listPlaybooks, playbookToCategoryDefs, playbookToEvalCategories, regulationsFor,
} from "../src/playbook";

const pb = PACKAGING_BENGALURU;
const bySlug = new Map(pb.categories.map((c) => [c.slug, c]));
const evalDir = join(__dirname, "../../ai/evals/proposed", pb.key);
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(evalDir, f), "utf8")) as T;

describe("playbook registry", () => {
  it("is inert data: registered, validated, nothing loaded", () => {
    expect(Object.keys(PLAYBOOKS)).toEqual(["packaging-bengaluru"]);
    expect(getPlaybook("packaging-bengaluru")).toBe(pb);
    expect(getPlaybook("toString")).toBeNull();
    expect(listPlaybooks()[0]).toMatchObject({ key: "packaging-bengaluru", categories: pb.categories.length });
    expect(PlaybookSchema.safeParse(pb).success).toBe(true);
  });
  it("records the ADR-011 status and the language ordering", () => {
    expect(pb.decisionStatus).toMatch(/pending field validation/);
    expect(pb.languages).toEqual(["hi", "en", "kn", "ta", "te"]);
  });
  it("is frozen against accidental mutation of the registry", () => {
    expect(Object.isFrozen(PLAYBOOKS)).toBe(true);
  });
});

describe("packaging playbook data validity", () => {
  it("has a single rooted tree without cycles", () => {
    const roots = pb.categories.filter((c) => !c.parentSlug);
    expect(roots.map((r) => r.slug)).toEqual(["packaging-materials"]);
    for (const c of pb.categories) {
      const seen = new Set<string>();
      for (let cur: typeof c | undefined = c; cur; cur = cur.parentSlug ? bySlug.get(cur.parentSlug) : undefined) {
        expect(seen.has(cur.slug)).toBe(false);
        seen.add(cur.slug);
      }
      expect(seen.has("packaging-materials")).toBe(true);
    }
  });
  it("uses well-formed HSN codes (2-8 digits), none on the root, at least one per leaf trade category", () => {
    for (const c of pb.categories) {
      for (const h of c.hsn) expect(h, `${c.slug}: ${h}`).toMatch(HSN_RE);
      if (!c.prohibited && c.slug !== "packaging-materials") expect(c.hsn.length, c.slug).toBeGreaterThan(0);
    }
  });
  it("uses only canonical trade units, defaults inside the allowed lists, positive typical MOQ", () => {
    for (const c of pb.categories.filter((x) => x.units)) {
      const u = c.units!;
      for (const x of [...u.price, ...u.moq]) expect(TRADE_UNITS as readonly string[]).toContain(x);
      expect(u.price).toContain(u.defaultPrice);
      expect(u.moq).toContain(u.defaultMoq);
      expect(Number.isInteger(u.typicalMoq) && u.typicalMoq >= 1).toBe(true);
    }
  });
  it("attribute units are known symbols on number fields, selects have unique options, variant axes exist", () => {
    for (const c of pb.categories) {
      for (const a of c.attributes) {
        if (a.unit) {
          expect(ATTRIBUTE_UNITS as readonly string[]).toContain(a.unit);
          expect(a.type).toBe("number");
        }
        if (a.type === "select") expect(new Set(a.options!.map((o) => o.toLowerCase())).size).toBe(a.options!.length);
      }
      const keys = new Set(c.attributes.map((a) => a.key));
      for (const v of c.variantAxes) expect(keys.has(v), `${c.slug}.${v}`).toBe(true);
      if (!c.prohibited && c.slug !== "packaging-materials") expect(c.variantAxes.length, c.slug).toBeGreaterThan(0);
    }
  });
  it("dimension fields carry mm and size-like keys end in their unit", () => {
    for (const c of pb.categories) {
      for (const a of c.attributes) {
        if (/_mm$/.test(a.key)) expect(a.unit, `${c.slug}.${a.key}`).toBe("mm");
        if (/_micron$/.test(a.key)) expect(a.unit).toBe("micron");
        if (/_kg$/.test(a.key)) expect(a.unit).toBe("kg");
        if (/_ml$/.test(a.key)) expect(a.unit).toBe("ml");
      }
    }
  });
  it("prohibited subcategories carry no schema; the ban category exists", () => {
    const banned = pb.categories.filter((c) => c.prohibited);
    expect(banned.map((c) => c.slug)).toEqual(["banned-single-use-plastics"]);
    for (const b of banned) expect(b.attributes).toHaveLength(0);
  });
  it("regulatory flags are coherent: BIS regimes state QCO status; a QCO in force needs a certificate", () => {
    for (const c of pb.categories) for (const r of c.regulations) {
      if (r.kind === "bis-qco" || r.kind === "bis-standard") expect(r.qcoStatus).toBeDefined();
      if (r.qcoStatus === "in-force") expect(r.requiresCertificate).toBe(true);
      if (r.verifiedOn) expect(Number.isNaN(Date.parse(r.verifiedOn))).toBe(false);
    }
  });
  it("schema rejects an in-force QCO that does not require a certificate", () => {
    const bad = structuredClone(pb);
    bad.categories[1]!.regulations = [{ kind: "bis-qco", standard: "IS 0000", qcoStatus: "in-force", requiresCertificate: false }];
    expect(PlaybookSchema.safeParse(bad).success).toBe(false);
  });
  it("schema rejects dangling parents, bad HSN, bad units and duplicate slugs", () => {
    const mut = (f: (p: typeof pb) => void) => { const c = structuredClone(pb); f(c); return PlaybookSchema.safeParse(c).success; };
    expect(mut((p) => { p.categories[1]!.parentSlug = "nope"; })).toBe(false);
    expect(mut((p) => { p.categories[1]!.hsn = ["48A9"]; })).toBe(false);
    expect(mut((p) => { p.categories[1]!.hsn = ["1"]; })).toBe(false);
    expect(mut((p) => { p.categories[1]!.hsn = ["123456789"]; })).toBe(false);
    expect(mut((p) => { p.categories[1]!.units!.defaultMoq = "tonne"; })).toBe(false);
    expect(mut((p) => { p.categories[2]!.slug = p.categories[1]!.slug; })).toBe(false);
    expect(mut((p) => { p.categories[1]!.variantAxes = ["ghost"]; })).toBe(false);
    expect(mut((p) => { p.languages = ["hi", "hi"]; })).toBe(false);
  });
});

describe("category mapping", () => {
  const defs = playbookToCategoryDefs(pb);
  it("maps every playbook category to a CategoryDef with parent, lead cap and schema", () => {
    expect(defs).toHaveLength(pb.categories.length);
    const box = defs.find((d) => d.slug === "corrugated-boxes")!;
    expect(box.parentSlug).toBe("packaging-materials");
    expect(box.leadCap).toBe(3);
    expect(box.attributeSchema!.fields.find((f) => f.key === "length_mm")).toMatchObject({ type: "number", unit: "mm", required: true });
    expect(defs.find((d) => d.slug === "banned-single-use-plastics")).toMatchObject({ prohibited: true });
  });
  it("adds a required certificate field exactly to categories whose regulations require one", () => {
    for (const c of pb.categories) {
      const def = defs.find((d) => d.slug === c.slug)!;
      const has = def.attributeSchema!.fields.some((f) => f.key === CERTIFICATE_FIELD.key && f.required);
      expect(has, c.slug).toBe(c.regulations.some((r) => r.requiresCertificate));
    }
    expect(defs.find((d) => d.slug === "food-grade-containers")!.attributeSchema!.fields.some((f) => f.key === "certificate_ref")).toBe(true);
  });
  it("is deterministic and pure (no mutation of the playbook)", () => {
    const before = JSON.stringify(pb);
    expect(JSON.stringify(playbookToCategoryDefs(pb))).toBe(JSON.stringify(defs));
    expect(JSON.stringify(pb)).toBe(before);
  });
  it("certificate requirement applies to descendants of a regulated category", () => {
    expect(categoryNeedsCertificate(pb, "food-grade-containers")).toBe(true);
    expect(categoryNeedsCertificate(pb, "corrugated-boxes")).toBe(false);
    expect(regulationsFor(pb, "food-grade-containers").length).toBeGreaterThan(regulationsFor(pb, "plastic-containers").length);
  });
});

describe("constraints", () => {
  it("rejects carry bags below 120 micron and accepts 120", () => {
    expect(checkPlaybookConstraints(pb, "plastic-carry-bags", { thickness_micron: 40 })).toHaveLength(1);
    expect(checkPlaybookConstraints(pb, "plastic-carry-bags", { thickness_micron: "119" })).toHaveLength(1);
    expect(checkPlaybookConstraints(pb, "plastic-carry-bags", { thickness_micron: 120 })).toEqual([]);
  });
  it("flags prohibited categories and ignores unknown ones", () => {
    expect(checkPlaybookConstraints(pb, "banned-single-use-plastics", {})).toHaveLength(1);
    expect(checkPlaybookConstraints(pb, "no-such", { x: 1 })).toEqual([]);
  });
  it("enforces ply and percentage ranges", () => {
    expect(checkPlaybookConstraints(pb, "corrugated-boxes", { ply: 12 })).toHaveLength(1);
    expect(checkPlaybookConstraints(pb, "corrugated-boxes", { ply: 5 })).toEqual([]);
    expect(checkPlaybookConstraints(pb, "food-grade-containers", { recycled_content_pct: 140 })).toHaveLength(1);
  });
});

describe("no hardcoding of the vertical outside the playbook data", () => {
  it("no product source file references the playbook key or its root category slug", () => {
    const root = join(__dirname, "../../..");
    const hits: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = entry.name;
        if (name === "node_modules" || name === ".next" || name === "dist") continue;
        const p = join(dir, name);
        if (entry.isDirectory()) { scan(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (p.includes("/packages/verticals/src/playbook/") || p.includes("/test/") || p.includes(".test.")) continue;
        const text = readFileSync(p, "utf8");
        if (/packaging-bengaluru|packaging-materials/.test(text)) hits.push(p.replace(root, ""));
      }
    };
    for (const group of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(root, group))) {
        const src = join(root, group, pkg, "src");
        if (existsSync(src)) scan(src);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("proposed golden sets (packages/ai/evals/proposed)", () => {
  type Ex = { id: string; text: string; language?: string; expect: { categorySlug: string; pricePaise?: number; priceUnit?: string; moq?: number; moqUnit?: string; hsn?: string; attributes?: Record<string, string | number> } };
  const ex = readJson<Ex[]>("extraction.json");
  const intent = readJson<{ id: string; input: { title: string; requirement: string }; band: [number, number] }[]>("intent.json");
  const mod = readJson<{ id: string; text: string; verdict: string; tags?: string[] }[]>("moderation.json");

  it("ids are unique within each set and across sets of the same capability", () => {
    for (const set of [ex, intent, mod]) expect(new Set(set.map((x) => x.id)).size).toBe(set.length);
  });
  it("extraction expectations match the playbook (category, units, attribute keys, types and options, HSN)", () => {
    for (const c of ex) {
      const cat = bySlug.get(c.expect.categorySlug);
      expect(cat, `${c.id}: category`).toBeDefined();
      expect(cat!.prohibited).not.toBe(true);
      const u = cat!.units!;
      if (c.expect.priceUnit) expect(u.price, `${c.id}: priceUnit`).toContain(c.expect.priceUnit);
      if (c.expect.moqUnit) expect(u.moq, `${c.id}: moqUnit`).toContain(c.expect.moqUnit);
      if (c.expect.pricePaise !== undefined) expect(Number.isInteger(c.expect.pricePaise) && c.expect.pricePaise >= 0).toBe(true);
      if (c.expect.hsn) {
        expect(c.expect.hsn).toMatch(HSN_RE);
        expect(cat!.hsn.some((h) => h.startsWith(c.expect.hsn!) || c.expect.hsn!.startsWith(h)), `${c.id}: hsn ${c.expect.hsn}`).toBe(true);
      }
      for (const [k, v] of Object.entries(c.expect.attributes ?? {})) {
        const f = cat!.attributes.find((a) => a.key === k);
        expect(f, `${c.id}: attribute ${k}`).toBeDefined();
        if (f!.type === "number") expect(typeof v, `${c.id}.${k}`).toBe("number");
        else expect(typeof v).toBe("string");
        if (f!.type === "select") expect(f!.options, `${c.id}.${k}=${v}`).toContain(v);
      }
      if (c.language) expect(pb.languages).toContain(c.language);
    }
  });
  it("covers the playbook languages used for Hinglish and a spread of categories", () => {
    expect(ex.some((c) => c.language === "hi")).toBe(true);
    expect(new Set(ex.map((c) => c.expect.categorySlug)).size).toBeGreaterThanOrEqual(8);
  });
  it("intent bands are valid ranges within 0-100", () => {
    for (const c of intent) {
      expect(c.band[0]).toBeGreaterThanOrEqual(0);
      expect(c.band[1]).toBeLessThanOrEqual(100);
      expect(c.band[0]).toBeLessThan(c.band[1]);
    }
  });
  it("moderation verdicts are valid and cover allow, review and block", () => {
    for (const c of mod) expect(["allow", "review", "block"]).toContain(c.verdict);
    for (const v of ["allow", "review", "block"]) expect(mod.some((c) => c.verdict === v)).toBe(true);
  });
  it("categories.json equals the playbook-derived eval categories (regenerate with scripts/export-eval-categories.ts)", () => {
    expect(readJson("categories.json")).toEqual(JSON.parse(JSON.stringify(playbookToEvalCategories(pb))));
  });
  it("did not leak into the committed eval data (baselines stay valid)", () => {
    const committed = JSON.parse(readFileSync(join(__dirname, "../../ai/evals/data/extraction.json"), "utf8")) as { id: string }[];
    const mine = new Set(ex.map((c) => c.id));
    expect(committed.some((c) => mine.has(c.id))).toBe(false);
    const cats = JSON.parse(readFileSync(join(__dirname, "../../ai/evals/data/categories.json"), "utf8")) as { slug: string }[];
    expect(cats.some((c) => c.slug === "packaging-materials")).toBe(false);
  });
});
