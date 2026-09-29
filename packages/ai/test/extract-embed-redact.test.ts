import { EMBEDDING_DIM } from "@cnote/db";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cosine, embed, embedText, EMBEDDER_VERSION, redactDeep, redactPii } from "../src";
import { hash32, localEmbedder } from "../src/embedder";
import { extractListingHeuristic, schemaFields } from "../src/heuristic/extract";
import { normalizeText, normalizeUnit, tokenize } from "../src/text";
import triplets from "../evals/data/embedding.json";
import categories from "../evals/data/categories.json";

const ex = (text: string, cats: any[] = []) => extractListingHeuristic({ text, language: "en", categories: cats }).output;

describe("price parsing table", () => {
  it.each([
    ["Rs 1,200 per kg", 120000, "kg"], ["₹ 1200/kg", 120000, "kg"], ["INR 1200.50 each", 120050, null], ["rupees 500 per piece", 50000, "piece"],
    ["rate 45 /mtr", 4500, "meter"], ["Rs.5", 500, null], ["1200 Rs/kg", 120000, "kg"], ["price: 1,20,000", 12000000, null],
    ["₹0.50/pc", 50, "piece"], ["Rs 99.99 per dozen", 9999, "dozen"], ["bhav 30 per kg", 3000, "kg"],
  ])("%j -> %i paise unit %j", (t, paise, unit) => {
    const o = ex(t);
    expect(o.pricePaise).toBe(paise);
    expect(o.priceUnit).toBe(unit);
  });
  it.each(["10/12 inch", "no price here", "Rs 0", "MOQ 500 pcs"])("no price in %j", (t) => expect(ex(t).pricePaise).toBeNull());
  it("PROPERTY: Indian/western grouping, prefix spelling and spacing all parse to the same paise", () =>
    fc.assert(fc.property(fc.integer({ min: 1, max: 9_999_999 }), fc.integer({ min: 0, max: 99 }), fc.constantFrom("₹", "Rs", "Rs.", "rs", "INR", "rupees"), fc.constantFrom("", " "), fc.constantFrom("/kg", " per kg", " / kg"), (rupees, paisa, pre, sp, per) => {
      const plain = `${rupees}.${String(paisa).padStart(2, "0")}`;
      const western = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + String(paisa).padStart(2, "0");
      const indian = (() => { const s = rupees.toString(); if (s.length <= 3) return s; const last3 = s.slice(-3); return s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3; })() + "." + String(paisa).padStart(2, "0");
      const expected = rupees * 100 + paisa;
      for (const n of [plain, western, indian]) {
        const o = ex(`${pre}${sp}${n}${per}`);
        expect(o.pricePaise).toBe(expected);
        expect(o.priceUnit).toBe("kg");
      }
    })));
});

describe("MOQ / HSN parsing", () => {
  it.each([["MOQ: 1,000 pcs", 1000, "piece"], ["min order qty 50 sets", 50, "set"], ["minimum 20", 20, null], ["MOQ 500 pieces", 500, "piece"], ["moq-10 kg", 10, "kg"]])("%j", (t, moq, unit) => {
    expect(ex(t).moq).toBe(moq);
    expect(ex(t).moqUnit).toBe(unit);
  });
  it("no MOQ", () => expect(ex("cotton bags").moq).toBeNull());
  it.each([["HSN code 4819", "4819"], ["HSN: 481910", "481910"], ["hsn no. 48191010", "48191010"], ["HSN 12", null], ["HSN 123456789", null], ["no code", null]])("%j -> %j", (t, h) => expect(ex(t).hsn).toBe(h));
  it("PROPERTY: any 4-8 digit HSN with any separator parses", () =>
    fc.assert(fc.property(fc.stringMatching(/^[0-9]{4,8}$/), fc.constantFrom(" ", ": ", " - ", ":"), fc.constantFrom("hsn", "HSN", "HSN code", "hsn no"), (d, sep, kw) => {
      expect(ex(`Bags ${kw}${sep}${d}`).hsn).toBe(d);
    })));
});

describe("category, attributes, title, confidence", () => {
  const cats = categories as any[];
  it("picks the category and pulls schema attributes", () => {
    const o = ex("3 ply corrugated boxes gsm 180 material kraft Rs 5 per piece MOQ 500 pcs HSN 4819", cats);
    expect(o.categorySlug).toBe("corrugated-boxes");
    expect(o.attributes).toMatchObject({ ply: 3, gsm: 180 });
    expect(o.pricePaise).toBe(500);
  });
  it("select attribute matches option as whole word only", () => {
    const o = ex("Fabric cotton 150 gsm width 44 inches", cats);
    expect(o.categorySlug).toBe("fabric");
    expect(o.attributes.material).toBe("cotton");
    expect(ex("fabric cottonwood", cats).attributes.material).toBeUndefined();
  });
  it("no category when text is unrelated; attributes empty then", () => {
    const o = ex("random thing", cats);
    expect(o.categorySlug).toBeNull();
    expect(o.attributes).toEqual({});
  });
  it("schemaFields tolerates junk", () => {
    expect(schemaFields(null)).toEqual([]);
    expect(schemaFields({ fields: "x" })).toEqual([]);
    expect(schemaFields({ fields: [null, { nokey: 1 }, { key: "a", type: "text" }] })).toEqual([{ key: "a", label: "a", type: "text" }]);
  });
  it("title is Title Case without price/MOQ/filler; confidence rises with evidence and is capped", () => {
    const rich = extractListingHeuristic({ text: "We sell cotton bags, Rs 5 per piece, MOQ 500 pcs, HSN 4819", language: "en", categories: [{ slug: "cotton-bags", name: "Cotton Bags", attributeSchema: { fields: [{ key: "gsm", label: "GSM", type: "number" }] } }] });
    expect(rich.output.title).toBe("Cotton Bags");
    const bare = extractListingHeuristic({ text: "stuff", language: "en", categories: [] });
    expect(rich.confidence).toBeGreaterThan(bare.confidence);
    expect(bare.confidence).toBe(0.3);
    expect(rich.confidence).toBeLessThanOrEqual(0.95);
  });
  it("PROPERTY: never throws, price/moq never negative or NaN, on arbitrary text", () =>
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (t) => {
      const o = ex(t, categories as any[]);
      for (const n of [o.pricePaise, o.moq]) if (n !== null) expect(Number.isFinite(n) && n > 0).toBe(true);
      expect(typeof o.title).toBe("string");
    }), { numRuns: 300 }));
});

describe("text utils", () => {
  it("units and synonyms", () => {
    expect(normalizeUnit("PCS.")).toBe("piece");
    expect(normalizeUnit("m")).toBe("meter");
    expect(normalizeUnit("zzz")).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(tokenize("Gatta dabba 5ply 500 pcs")).toEqual(["carton", "box", "5", "ply", "500", "piece"]);
    expect(tokenize("₹500 sq. ft")).toEqual(["rupee", "500", "sqft"]);
    expect(tokenize("boxes glasses ladies")).toEqual(["box", "glass", "lady"]);
    expect(normalizeText("The box of cotton")).toBe("box cotton");
  });
  it("PROPERTY: tokenize never throws, tokens are non-empty and lowercase", () =>
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
      for (const t of tokenize(s)) { expect(t.length).toBeGreaterThan(0); expect(t).toBe(t.toLowerCase()); }
    })));
});

describe("embedder", () => {
  it("hash32 is a stable uint32", () => {
    expect(hash32("a")).toBe(hash32("a"));
    expect(hash32("a")).not.toBe(hash32("b"));
    fc.assert(fc.property(fc.string(), (s) => { const h = hash32(s); expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true); }));
  });
  it("PROPERTY: deterministic, dimension, unit-norm, finite for arbitrary text", () =>
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 300 }), (s) => {
      const a = embedText(s);
      expect(a).toEqual(embedText(s));
      expect(a).toHaveLength(EMBEDDING_DIM);
      expect(a.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    })));
  it("PROPERTY: self-similarity is 1 and cosine is symmetric and in [-1,1]", () =>
    fc.assert(fc.property(fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 }), (a, b) => {
      const x = embedText(a), y = embedText(b);
      expect(cosine(x, x)).toBeCloseTo(1, 6);
      expect(cosine(x, y)).toBeCloseTo(cosine(y, x), 9);
      expect(Math.abs(cosine(x, y))).toBeLessThanOrEqual(1 + 1e-9);
    })));
  it("golden triplets: positive > negative for every triplet", () => {
    for (const t of triplets as any[]) expect(cosine(embedText(t.anchor), embedText(t.positive)), t.id).toBeGreaterThan(cosine(embedText(t.anchor), embedText(t.negative)));
  });
  it("generated variants: case, spacing, punctuation, plural, unit spelling stay close; unrelated stays far", () => {
    const anchors = ["corrugated box 5 ply", "cotton fabric 150 gsm", "steel pipes seamless 2 inch", "jute sack 50 kg", "LED bulb 9 watt"];
    const variants = (s: string) => [s.toUpperCase(), `  ${s}  `.replace(/ /g, "   "), `${s}!!!`, s.replace("box", "boxes")];
    for (const a of anchors) {
      for (const v of variants(a)) expect(cosine(embedText(a), embedText(v)), `${a} ~ ${v}`).toBeGreaterThan(0.85);
      for (const o of anchors.filter((x) => x !== a)) expect(cosine(embedText(a), embedText(o))).toBeLessThan(0.5);
    }
  });
  it("cosine handles zero vectors and localEmbedder API", async () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(localEmbedder.version).toBe(EMBEDDER_VERSION);
    expect((await embed([])).vectors).toEqual([]);
  });
});

describe("redaction property", () => {
  const digit = fc.integer({ min: 0, max: 9 });
  const phone = fc.tuple(fc.constantFrom("6", "7", "8", "9"), fc.array(digit, { minLength: 9, maxLength: 9 }), fc.constantFrom("", "+91", "+91 ", "91-", "0"), fc.constantFrom("", " ", "-")).map(([f, r, pre, sep]) => `${pre}${f}${r.slice(0, 4).join("")}${sep}${r.slice(4).join("")}`);
  const upper = (n: number) => fc.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"), { minLength: n, maxLength: n }).map((a) => a.join(""));
  const digs = (n: number) => fc.array(digit, { minLength: n, maxLength: n }).map((a) => a.join(""));
  const pan = fc.tuple(upper(5), digs(4), upper(1)).map((p) => p.join(""));
  const gstin = fc.tuple(digs(2), pan, fc.constantFrom("1", "2", "A"), fc.constantFrom("Z")).map(([st, p, e, z]) => `${st}${p}${e}${z}5`);
  const aadhaar = fc.tuple(digs(4), digs(4), digs(4), fc.constantFrom(" ", "-", "")).map(([a, b, c, s]) => [a, b, c].join(s));
  const email = fc.tuple(fc.stringMatching(/^[a-z][a-z0-9._]{1,10}$/), fc.stringMatching(/^[a-z]{2,8}$/), fc.constantFrom("com", "in", "co.in")).map(([u, d, t]) => `${u}@${d}.${t}`);

  it("no phone/email/PAN/GSTIN/Aadhaar survives, in any surrounding text", () =>
    fc.assert(fc.property(fc.constantFrom(phone, email, pan, gstin, aadhaar).chain((a) => a), fc.constantFrom("call ", "mail: ", "id ", ""), fc.constantFrom(" thanks", ".", ""), (pii, pre, post) => {
      const out = redactPii(`${pre}${pii}${post}`);
      expect(out).not.toContain(pii.trim());
      expect(out).toMatch(/\[(phone|email|pan|gstin|aadhaar)\]/);
    }), { numRuns: 500 }));
  it("idempotent and leaves PII-free text alone", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z ]{0,40}$/), (s) => { expect(redactPii(s)).toBe(s); }));
    const once = redactPii("call 9876543210");
    expect(redactPii(once)).toBe(once);
  });
  it("redactDeep handles nesting, non-strings, null", () => {
    expect(redactDeep({ a: { b: ["9876543210", 1, null, true] }, c: undefined })).toEqual({ a: { b: ["[phone]", 1, null, true] }, c: undefined });
  });
});
