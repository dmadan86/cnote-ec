import { describe, expect, it } from "vitest";
import { moderateHeuristic } from "../src/heuristic/moderate";

const verdict = (text: string) => moderateHeuristic({ text }).output.verdict;
const flags = (text: string) => moderateHeuristic({ text }).output.flags;

describe("moderation corpus: must block", () => {
  it.each([
    "tramadol 100mg wholesale", "alprazolam tablets", "schedule h drugs supplier", "sildenafil", "codeine syrup",
    "cocaine", "heroin", "ganja", "afeem supply", "अफीम", "charas",
    "dynamite sticks", "gunpowder", "patakhe wholesale", "पटाखे", "fire crackers diwali", "detonators", "ammonium nitrate",
    "pistol", "AK-47", "ak 47", "desi katta", "bandook", "बंदूक", "ammunition", "butterfly knife", "revolver",
    "sodium cyanide", "endosulfan", "paraquat", "sulphuric acid 98%", "nitric acid",
    "ivory carving", "shahtoosh shawl", "pangolin scales", "tiger skin", "hathi dant",
    "first copy shoes", "first-copy watches", "1st copy bags", "master copy rolex", "7a quality sneakers", "replica watches", "copy of nike shoes",
    "porn videos", "sex toys", "escort service", "vape juice", "e cigarette", "gutkha", "gutka pouch", "hookah flavour",
    "TRAMADOL", "ｔｒａｍａｄｏｌ", // fullwidth via NFKC
    "Tramadol\n\ttablets", "Nike Air (first  copy) bulk",
  ])("blocks %j", (t) => {
    const r = moderateHeuristic({ text: t });
    expect(r.output.verdict).toBe("block");
    expect(r.output.flags.length).toBeGreaterThan(0);
    expect(r.output.reason).toMatch(/prohibited/);
    expect(r.confidence).toBe(0.95);
  });
});

describe("moderation corpus: needs review (ambiguous)", () => {
  it.each(["citric acid food grade", "rum", "wine glass", "beer bottle caps", "daru", "cigarette paper", "fake leather", "sparklers", "pepper spray", "tobacco leaf", "pesticide sprayer", "lingerie", "nakli", "sword fish", "tezaab"])("reviews %j", (t) => {
    const r = moderateHeuristic({ text: t });
    expect(r.output.verdict).toBe("review");
    expect(r.confidence).toBe(0.6);
    expect(r.output.reason).toMatch(/review/);
  });
});

describe("moderation corpus: legitimate B2B stays allowed", () => {
  it.each([
    "plastic injection moulding machine", "injection molding grade ABS", "glue gun 40w", "hot melt glue gun", "acid free paper", "acid resistant tiles",
    "corrugated boxes 5 ply", "bullet train model", "bulletproof jacket", "bomb disposal suit", "alcohol wipes", "water gun toy", "hemp fabric",
    "cotton t-shirts", "steel pipes", "tablet stand", "tablet pc cover", "", "   ",
  ])("allows %j", (t) => {
    const r = moderateHeuristic({ text: t });
    expect(r.output).toMatchObject({ verdict: "allow", flags: [], reason: null });
  });
});

describe("moderation properties of the output", () => {
  it("blocks win over review; flags are unique and named", () => {
    const r = moderateHeuristic({ text: "tramadol and also tobacco and pistol" }).output;
    expect(r.verdict).toBe("block");
    expect(r.flags).toEqual(expect.arrayContaining(["pharma", "weapons"]));
    expect(r.flags).not.toContain("tobacco_alcohol");
    expect(new Set(r.flags).size).toBe(r.flags.length);
  });
  it("apostrophes and case do not matter", () => expect(verdict("PISTOL’s")).toBe("block"));
  it("short text has lower allow confidence", () => {
    expect(moderateHeuristic({ text: "boxes" }).confidence).toBe(0.75);
    expect(moderateHeuristic({ text: "corrugated boxes for shipping" }).confidence).toBe(0.88);
  });
  it("categorySlug is ignored by the heuristic (prohibited always rejected regardless of category)", () => {
    expect(moderateHeuristic({ text: "pistol", categorySlug: "toys" }).output.verdict).toBe("block");
  });
});

// Formerly KNOWN GAPS of heuristic v1 (obfuscation + two false positives), closed by the v2 evasion-aware pass.
// passes while the gap exists; when the heuristic learns to catch these, the test flips red so it can be promoted.
describe("KNOWN GAPS: obfuscation and homoglyphs", () => {
  it("letter-spaced words: p i s t o l", () => expect(verdict("p i s t o l")).toBe("block"));
  it("leetspeak digit substitution: tramad0l", () => expect(verdict("tramad0l")).toBe("block"));
  it("leetspeak symbol substitution: tr@madol", () => expect(verdict("tr@madol")).toBe("block"));
  it("leetspeak in narcotics: c0caine", () => expect(verdict("c0caine")).toBe("block"));
  it("cyrillic homoglyph a in tramаdol", () => expect(verdict("tramаdol")).toBe("block"));
  it("hyphen-split word: tram-adol", () => expect(verdict("tram-adol")).toBe("block"));
  it("spaced narcotics: gan ja", () => expect(verdict("gan ja")).toBe("block"));
  it("mercury thermometer (hazardous, only 'mercury metal/liquid' matches)", () => expect(verdict("mercury thermometer")).not.toBe("allow"));
  it("false positive: colour 'ivory white paint' should not be blocked as wildlife", () => expect(verdict("ivory white paint")).not.toBe("block"));
  it("false positive: 'bomb calorimeter' lab instrument", () => expect(verdict("bomb calorimeter")).not.toBe("block"));
});

// v2 must not create new false positives on everyday B2B text while hunting obfuscation.
describe("evasion pass does not flag legitimate listings", () => {
  it.each([
    "organ jar for pharmacy display", "hot-melt glue gun 60W", "bath bomb gift set", "ivory colour silk saree", "ivory white wall paint 20L",
    "SKU 7A-120 m8 bolts", "10mg sample sachets of food colour", "l shaped steel angle", "co2 cylinder 10 kg",
    "a to z stationery kit", "i am a manufacturer of kraft boxes", "tr-01 tractor spare", "b2b bulk c0rrugated boxes",
  ])("allows: %s", (t) => expect(verdict(t)).toBe("allow"));

  it.each([
    ["p.i.s.t.o.l for sale", "weapons"], ["cod-eine syrup", "pharma"], ["h e r o i n", "narcotics"], ["dyn@mite sticks", "explosives"], ["ivоry carving", "wildlife"],
  ])("blocks obfuscated: %s", (t, cls) => {
    expect(verdict(t)).toBe("block");
    expect(flags(t)).toContain(cls);
  });
});

describe("evasion pass internals", () => {
  it("reports a class once when both de-obfuscation paths find it", () => {
    const out = moderateHeuristic({ text: "tramad0l and t r a m a d o l" }).output;
    expect(out.verdict).toBe("block");
    expect(out.flags).toEqual(["pharma"]);
  });
  it("leaves non-look-alike Greek/Cyrillic letters alone (no false folding)", () => {
    expect(verdict("λ-sensor module")).toBe("allow");
    expect(verdict("Жаккард fabric roll")).toBe("allow");
  });
});
