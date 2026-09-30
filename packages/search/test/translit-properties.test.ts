import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normaliseQuery } from "../src/normalise";
import { colloquial, detectScript, fromRoman, romanVariants, toRoman } from "../src/translit/indic";
import { expandQuery, MAX_VARIANTS } from "../src/translit/variants";

// Devanagari generators: consonants (incl. nukta forms), vowel signs, independent vowels, marks, virama.
const CONS = [..."कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह"];
const NUKTA = ["क़", "ख़", "ग़", "ज़", "ड़", "ढ़", "फ़"]; // ya-nukta excluded: ISO folds it into ya
const MATRA = ["", "", "ा", "ि", "ी", "ु", "ू", "े", "ै", "ो", "ौ", "ृ"];
const VOWEL = [..."अआइईउऊएऐओऔ"];
const MARK = ["", "", "", "ं", "ँ", "ः"];

const syllable = fc.tuple(fc.constantFrom(...CONS, ...NUKTA.map((c) => c.normalize("NFC"))), fc.constantFrom(...MATRA), fc.constantFrom(...MARK)).map(([c, m, k]) => c + m + k);
const cluster = fc.tuple(fc.constantFrom(...CONS), fc.constantFrom(...CONS)).map(([a, b]) => `${a}्${b}`);
const independent = fc.tuple(fc.constantFrom(...VOWEL), fc.constantFrom(...MARK)).map(([v, k]) => v + k);
const dWord = fc.array(fc.oneof({ weight: 6, arbitrary: syllable }, { weight: 1, arbitrary: cluster }, { weight: 1, arbitrary: independent }), { minLength: 1, maxLength: 6 }).map((a) => a.join("").normalize("NFC"));

const anyIndicish = fc.oneof(dWord, fc.string({ unit: "grapheme", maxLength: 30 }), fc.stringMatching(/^[a-zA-Z ]{0,20}$/), fc.string({ unit: fc.integer({ min: 0x0900, max: 0x0d7f }).map((n) => String.fromCodePoint(n)), maxLength: 12 }));

describe("transliteration properties", () => {
  it("round trip: fromRoman(toRoman(w), strict) === w for any Devanagari word (stable under repeat)", () => {
    fc.assert(
      fc.property(dWord, (w) => {
        const r = toRoman(w);
        const back = fromRoman(r, { strict: true });
        expect(back).toBe(w);
        expect(toRoman(back)).toBe(r); // idempotent second trip
      }),
      { numRuns: 500 },
    );
  });

  it("toRoman/colloquial never throw and colloquial output is printable ASCII for Indic-only input", () => {
    fc.assert(
      fc.property(dWord, (w) => {
        for (const v of romanVariants(w)) expect(v).toMatch(/^[\x20-\x7e]+$/);
        expect(colloquial(w, detectScript(w))).toMatch(/^[\x20-\x7e]*$/);
      }),
      { numRuns: 300 },
    );
    fc.assert(fc.property(anyIndicish, (s) => typeof toRoman(s) === "string" && typeof colloquial(s, null) === "string" && typeof fromRoman(s) === "string"), { numRuns: 300 });
  });

  it("every Indic word yields at least one non-empty Latin variant", () => {
    fc.assert(fc.property(dWord, (w) => romanVariants(w).length > 0 && romanVariants(w).every((v) => v.length > 0)), { numRuns: 300 });
  });

  it("Latin text passes through toRoman unchanged", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9 ]{0,30}$/), (s) => toRoman(s) === s));
  });
});

describe("expandQuery properties", () => {
  it("never drops or alters the original: variants exclude it, are capped, non-empty, trimmed, unique, deterministic", () => {
    fc.assert(
      fc.property(anyIndicish, (raw) => {
        const text = normaliseQuery(raw).text;
        const v = expandQuery(text);
        expect(v.length).toBeLessThanOrEqual(MAX_VARIANTS);
        expect(new Set(v).size).toBe(v.length);
        for (const x of v) {
          expect(x.trim()).toBe(x);
          expect(x.length).toBeGreaterThan(0);
          expect(x.length).toBeLessThanOrEqual(200);
          expect(x).not.toBe(text.normalize("NFC").replace(/\s+/g, " ").trim());
        }
        expect(expandQuery(text)).toEqual(v);
      }),
      { numRuns: 400 },
    );
  });

  it("the search text stays the buyer's own words (normalisation keeps Indic vowel signs)", () => {
    fc.assert(fc.property(dWord, (w) => normaliseQuery(w).text === w.toLowerCase().normalize("NFKC")), { numRuns: 200 });
  });

  it("a query with no Indic letters and no lexicon words produces no variants", () => {
    fc.assert(fc.property(fc.stringMatching(/^[qxzj]{3,8}( [qxzj]{3,8}){0,2}$/), (s) => expandQuery(s).length === 0), { numRuns: 100 });
  });
});
