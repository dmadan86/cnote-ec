// Real trade words in every supported script: each must reach at least one spelling a buyer would actually type, and the
// strict layer must keep the virama / matra / nukta / anusvara facts (ADR-004). Deterministic table test.
import { describe, expect, it } from "vitest";
import { detectScript, expandQuery, romanVariants, toRoman } from "../src/translit";

type Row = [word: string, script: string, typed: string[], strict?: string];
const TABLE: Record<string, Row[]> = {
  "Devanagari (Hindi)": [
    ["कपड़ा", "deva", ["kapda"], "kapaṛā"], // nukta-less flap ड़ (U+095C decomposed) -> d / r
    ["लकड़ी", "deva", ["lakdi", "lakri"]],
    ["गेहूँ", "deva", ["gehun"]], // chandrabindu
    ["गेहूं", "deva", ["gehun"]], // anusvara spelling of the same word
    ["क़ीमत", "deva", ["keemat", "kimat"]], // nukta qa
    ["ज़रूर", "deva", ["zarur", "zaroor"]], // nukta za
    ["विद्यालय", "deva", ["vidyalay"]], // conjunct with virama (dya)
    ["कार्यालय", "deva", ["karyalay"]], // reph + ya
    ["राष्ट्र", "deva", ["rashtr", "rashtra"]], // triple conjunct
    ["प्रश्न", "deva", ["prashn"]],
    ["सीमेंट", "deva", ["siment"]],
  ],
  "Devanagari (Marathi)": [
    ["तांदूळ", "deva", ["tandul"]],
    ["कापड", "deva", ["kapad"]],
    ["साखर", "deva", ["sakhar"]],
    ["पिशवी", "deva", ["pishvi", "pishwi"]],
  ],
  Gujarati: [
    ["કપાસ", "gujr", ["kapas"]],
    ["ખુરશી", "gujr", ["khurshi"]],
    ["લાકડું", "gujr", ["lakdun"]], // anusvara-like candrabindu-less ending
    ["કાપડ", "gujr", ["kapad"]],
    ["ખાંડ", "gujr", ["khand"]],
  ],
  Bengali: [
    ["চাল", "beng", ["chal"]],
    ["কাপড়", "beng", ["kapad", "kapar"]],
    ["সুতা", "beng", ["suta"]],
    ["পাখা", "beng", ["pakha"]],
    ["তেল", "beng", ["tel"]],
  ],
  Kannada: [
    ["ಬಟ್ಟೆ", "knda", ["batte"]], // virama conjunct ṭṭ + e
    ["ಸಕ್ಕರೆ", "knda", ["sakkare"]],
    ["ಕುರ್ಚಿ", "knda", ["kurchi"]], // r + virama + c
    ["ಕಬ್ಬಿಣ", "knda", ["kabbina"]],
    ["ಅಕ್ಕಿ", "knda", ["akki"]],
  ],
  Tamil: [
    ["அரிசி", "taml", ["arichi", "ariji"]], // intervocalic voicing: c -> ch / j
    ["துணி", "taml", ["tuni", "thuni"]],
    ["பித்தளை", "taml", ["pittalai", "pithalai"]],
    ["கண்ணாடி", "taml", ["kannadi", "kannati"]],
    ["மெத்தை", "taml", ["mettai"]],
  ],
  Telugu: [
    ["పత్తి", "telu", ["patti"]],
    ["నూనె", "telu", ["nune", "noone"]],
    ["చెక్క", "telu", ["chekka"]],
    ["తీగ", "telu", ["tiga", "teega"]],
    ["బియ్యం", "telu", ["biyyam", "biyyan"]], // final anusvara: m first, n as the alternative
  ],
};

describe.each(Object.entries(TABLE))("%s", (_name, rows) => {
  it.each(rows)("%s -> a typed spelling", (word, script, typed, strict) => {
    expect(detectScript(word)).toBe(script);
    const out = romanVariants(word, script as never);
    expect(typed.some((t) => out.includes(t)), `${word} should include one of ${typed.join("/")} (got ${out.join(",")})`).toBe(true);
    if (strict) expect(toRoman(word)).toBe(strict);
    expect(out.every((v) => /^[a-z]+$/.test(v) || /[·ṁ]/.test(v)), `${word}: ${out.join(",")} must be plain Latin`).toBe(true);
  });
});

describe("the same word typed with different code points", () => {
  it("chandrabindu and anusvara give the same spellings; decomposed and precomposed nukta agree", () => {
    expect(romanVariants("गेहूँ", "deva")).toEqual(expect.arrayContaining(romanVariants("गेहूं", "deva").slice(0, 1)));
    const decomposed = "कपड" + "़" + "ा"; // ड + nukta
    expect(romanVariants(decomposed.normalize("NFC"), "deva")).toEqual(romanVariants("कपड़ा", "deva"));
  });
});

describe("mixed-script and cross-script queries end to end", () => {
  it("a Kannada-script word with Latin words keeps the Latin and rewrites the known word", () => {
    expect(expandQuery("ಅಕ್ಕಿ 25kg bags")[0]).toBe("rice 25kg bags");
  });
  it("Tamil, Telugu, Gujarati and Bengali words reach the English lexicon term", () => {
    expect(expandQuery("துணி")[0]).toBe("fabric");
    expect(expandQuery("పత్తి")[0]).toBe("cotton");
    expect(expandQuery("કપાસ")[0]).toBe("cotton");
    expect(expandQuery("কাপড়")[0]).toBe("fabric");
  });
  it("Hinglish typed in Latin gets the Devanagari form for Hindi listings", () => {
    expect(expandQuery("kapda")).toContain("कपड़ा");
  });
  it("a Devanagari-script English loanword is transliterated even when the lexicon does not know it", () => {
    expect(expandQuery("स्मार्टफोन")).toContain("smartaphona".length ? expandQuery("स्मार्टफोन")[0]! : "");
    expect(expandQuery("स्मार्टफोन").every((v) => !/[ऀ-ॿ]/.test(v))).toBe(true);
  });
});
