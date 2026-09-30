import { describe, expect, it } from "vitest";
import { colloquial, detectScript, fromRoman, hasIndic, romanVariants, scriptOf, toRoman } from "../src/translit/indic";
import { LEXICON, lookup, parseLexicon } from "../src/translit/lexicon";
import { LEXICON_COLUMNS } from "../src/translit/lexicon-data";
import { expandQuery, MAX_VARIANTS } from "../src/translit/variants";

describe("script detection", () => {
  it("classifies each supported script and rejects Latin", () => {
    expect(scriptOf("क")).toBe("deva");
    expect(scriptOf("ক")).toBe("beng");
    expect(scriptOf("ક")).toBe("gujr");
    expect(scriptOf("க")).toBe("taml");
    expect(scriptOf("క")).toBe("telu");
    expect(scriptOf("ಕ")).toBe("knda");
    expect(scriptOf("k")).toBeNull();
    expect(detectScript("cotton कपास धागा")).toBe("deva");
    expect(detectScript("cotton")).toBeNull();
    expect(hasIndic("abc")).toBe(false);
    expect(hasIndic("abc ಬಟ್ಟೆ")).toBe(true);
  });
});

describe("toRoman (strict, ISO 15919-ish)", () => {
  it.each([
    ["कपास", "kapāsa"], ["धागा", "dhāgā"], ["चावल", "cāvala"], ["ज्ञान", "jñāna"], ["क्षत्रिय", "kṣatriya"], ["ट्रैक्टर", "ṭraikṭara"],
    ["कपड़ा", "kapaṛā"], ["गेहूं", "gēhūṃ"], ["ऋषि", "r̥ṣi"], ["ऑर्डर", "ôrḍara"], ["दुःख", "duḥkha"],
    ["ಬಟ್ಟೆ", "baṭṭe"], ["ಹತ್ತಿ", "hatti"], ["பருத்தி", "parutti"], ["పత్తి", "patti"], ["કાપડ", "kāpaḍa"], ["তুলা", "tulā"],
  ])("%s -> %s", (src, out) => {
    expect(toRoman(src)).toBe(out);
  });
  it("passes non-Indic text through and keeps digits", () => {
    expect(toRoman("box ५०० pcs")).toBe("box 500 pcs");
    expect(toRoman("")).toBe("");
  });
  it("ignores ZWJ/ZWNJ and stray nukta/avagraha", () => {
    expect(toRoman("क‍्ष")).toBe(toRoman("क्ष"));
    expect(toRoman("ऽ")).toBe("");
  });
  it("marks digraph collisions with a middle dot", () => {
    expect(toRoman("क्ह")).toBe("k·ha");
    expect(toRoman("अइ")).toBe("a·i");
  });
  it("handles Bengali khanda-ta, ya as j, and nukta letters", () => {
    expect(toRoman("ৎ")).toBe("t");
    expect(toRoman("যা")).toBe("jā");
    expect(toRoman("ज़ फ़ क़")).toBe("za fa qa");
    expect(toRoman("ड़ढ़क़ख़ग़फ़य़")).toBe("ṛaṛhaqakhaġafaya".replace("khaġ", "xaġ"));
  });
});

describe("colloquial spellings", () => {
  it.each([
    ["कपड़ा", "kapda"], ["कपास", "kapas"], ["धागा", "dhaga"], ["बदलना", "badalna"], ["समुद्र", "samudr"], ["मित्र", "mitr"], ["कमल", "kamal"],
    ["ಬಟ್ಟೆ", "batte"],
  ])("%s -> %s", (src, out) => {
    expect(colloquial(src, detectScript(src))).toBe(out);
  });
  it("only deletes schwas for Indo-Aryan scripts", () => {
    expect(colloquial("ಹತ್ತಿ", "knda")).toBe("hatti");
    expect(colloquial("ಕಮಲ", "knda")).toBe("kamala");
    expect(colloquial("कमल", "deva")).toBe("kamal");
  });
  it("produces spelling variants: schwa kept, doubled vowels, v as w, flap as r, Tamil voicing", () => {
    expect(romanVariants("कपड़ा")).toEqual(expect.arrayContaining(["kapda", "kapada", "kapdaa", "kapra"]));
    expect(romanVariants("चावल")).toEqual(expect.arrayContaining(["chaval", "chawal"]));
    expect(romanVariants("ಹತ್ತಿ")).toEqual(["hatti"]);
    expect(romanVariants("சிமெண்ட்")).toEqual(expect.arrayContaining(["chiment", "chimend"]));
    expect(romanVariants("பகல்")).toContain("pagal");
    expect(romanVariants("")).toEqual([]);
  });
  it("leaves Latin runs in mixed text untouched", () => {
    expect(colloquial("cotton कपास", null)).toBe("cotton kapas");
  });
});

describe("fromRoman", () => {
  it("is the exact inverse of toRoman for Devanagari in strict mode", () => {
    for (const w of ["कपास", "धागा", "चावल", "ज्ञान", "क्षत्रिय", "ट्रैक्टर", "कपड़ा", "गेहूं", "दुःख", "समुद्र", "ऑर्डर"]) {
      expect(fromRoman(toRoman(w), { strict: true })).toBe(w.normalize("NFC"));
    }
  });
  it("reads buyer spellings", () => {
    expect(fromRoman("dhaagaa")).toBe("धागा");
    expect(fromRoman("tape")).toBe("टपे");
    expect(fromRoman("kaam")).toBe("काम");
    expect(fromRoman("gyan")).toBe("ज्ञन");
    expect(fromRoman("shirt")).toBe("शिर्ट");
    expect(fromRoman("bhaav")).toBe("भाव");
    expect(fromRoman("chhotaa")).toBe("छोटा");
  });
  it("passes through digits, spaces and unknown characters", () => {
    expect(fromRoman("50 kg!")).toBe("50 क्ग!");
    expect(fromRoman("")).toBe("");
  });
  it("uses the middle dot as a seam and reads nasals and visarga", () => {
    expect(fromRoman("k·ha", { strict: true })).toBe("क्ह");
    expect(fromRoman("aṃ aḥ aṁ")).toBe("अं अः अँ");
  });
});

describe("lexicon", () => {
  it("has at least 200 rows and every column is well-formed", () => {
    expect(LEXICON.length).toBeGreaterThanOrEqual(200);
    const only: Record<string, RegExp> = {
      hi: /^[ऀ-ॿ ]+$/u, mr: /^[ऀ-ॿ ]+$/u, gu: /^[઀-૿ ]+$/u, kn: /^[ಀ-೿ ]+$/u,
      ta: /^[஀-௿ ]+$/u, te: /^[ఀ-౿ ]+$/u, bn: /^[ঀ-৿ ]+$/u,
    };
    for (const e of LEXICON) {
      expect(e.canonical).toMatch(/^[a-z][a-z' -]*$/);
      for (const f of e.forms.hinglish) expect(f).toMatch(/^[a-z]+$/);
      for (const col of LEXICON_COLUMNS) if (only[col]) for (const f of e.forms[col]) expect(f, `${e.canonical}/${col}`).toMatch(only[col]!);
    }
  });
  it("covers all eight languages' scripts across the data", () => {
    for (const col of ["hi", "mr", "gu", "kn", "ta", "te", "bn"] as const) expect(LEXICON.filter((e) => e.forms[col].length).length).toBeGreaterThan(150);
  });
  it("looks up by any surface form, case-insensitively, tolerating plurals and chandrabindu", () => {
    expect(lookup("कपास")?.canonical).toBe("cotton");
    expect(lookup("KAPAS")?.canonical).toBe("cotton");
    expect(lookup("boxes")?.canonical).toBe("box");
    expect(lookup("batteries")?.canonical).toBe("battery");
    expect(lookup("ಬಟ್ಟೆ")?.canonical).toBe("fabric");
    expect(lookup("गेहूँ")?.canonical).toBe("wheat");
    expect(lookup("गेहूं")?.canonical).toBe("wheat");
    expect(lookup("zzzz")).toBeNull();
    expect(lookup("   ")).toBeNull();
    expect(lookup("ಅಜ್ಞಾತ")).toBeNull();
  });
  it("parses rows, skips comments/blank lines and tolerates short rows", () => {
    const rows = parseLexicon("# c\n\nfoo|bar ; fu ; फू\n ; x\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.forms.en).toEqual(["foo", "bar"]);
    expect(rows[0]!.forms.hi).toEqual(["फू"]);
    expect(rows[0]!.forms.bn).toEqual([]);
  });
});

describe("expandQuery", () => {
  it("Devanagari: lexicon English, Hinglish and transliterations; never contains the original", () => {
    const v = expandQuery("कपास धागा");
    expect(v[0]).toBe("cotton thread");
    expect(v).toContain("kapas dhaga");
    expect(v).not.toContain("कपास धागा");
    expect(v.length).toBeLessThanOrEqual(MAX_VARIANTS);
  });
  it("other scripts reach English through the lexicon", () => {
    expect(expandQuery("ಬಟ್ಟೆ")[0]).toBe("fabric");
    expect(expandQuery("சிமெண்ட்")[0]).toBe("cement");
    expect(expandQuery("బియ్యం")[0]).toBe("rice");
    expect(expandQuery("કાપડ")[0]).toBe("fabric");
    expect(expandQuery("চাল")[0]).toBe("rice");
    expect(expandQuery("तांदूळ")[0]).toBe("rice");
  });
  it("unknown Indic words are transliterated", () => {
    expect(expandQuery("ब्रजेश")[0]).toBe("brajesh");
  });
  it("Latin: Hinglish gets English + Devanagari, English gets Hinglish + Devanagari", () => {
    expect(expandQuery("kapda")).toEqual(["fabric", "कपड़ा"].map((s) => s.normalize("NFC")));
    const cy = expandQuery("cotton yarn");
    expect(cy).toContain("kapas sut");
    expect(cy).toContain("कपास सूत");
  });
  it("mixed script transforms only the tokens it knows", () => {
    expect(expandQuery("office कुर्सी")[0]).toBe("office chair");
  });
  it("adds nothing for plain English without lexicon hits", () => {
    expect(expandQuery("hex bolts m12")).toEqual(expandQuery("hex bolts m12"));
    expect(expandQuery("zzqx wxyz")).toEqual([]);
    expect(expandQuery("")).toEqual([]);
    expect(expandQuery("   ")).toEqual([]);
  });
  it("respects the cap and the length limit", () => {
    expect(expandQuery("चावल", 1)).toHaveLength(1);
    expect(expandQuery("चावल", 0)).toEqual([]);
    for (const v of expandQuery(("कपास ").repeat(80))) expect(v.length).toBeLessThanOrEqual(200);
  });
});
