import { describe, expect, it } from "vitest";
import { moderateHeuristic } from "../src/heuristic/moderate";

const verdict = (text: string) => moderateHeuristic({ text }).output.verdict;

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

// KNOWN GAPS (heuristic v1): obfuscation the regex rules do not see. `it.fails` documents the DESIRED behaviour and
// passes while the gap exists; when the heuristic learns to catch these, the test flips red so it can be promoted.
describe("KNOWN GAPS: obfuscation and homoglyphs", () => {
  it.fails("letter-spaced words: p i s t o l", () => expect(verdict("p i s t o l")).toBe("block"));
  it.fails("leetspeak digit substitution: tramad0l", () => expect(verdict("tramad0l")).toBe("block"));
  it.fails("leetspeak symbol substitution: tr@madol", () => expect(verdict("tr@madol")).toBe("block"));
  it.fails("leetspeak in narcotics: c0caine", () => expect(verdict("c0caine")).toBe("block"));
  it.fails("cyrillic homoglyph a in tramаdol", () => expect(verdict("tramаdol")).toBe("block"));
  it.fails("hyphen-split word: tram-adol", () => expect(verdict("tram-adol")).toBe("block"));
  it.fails("spaced narcotics: gan ja", () => expect(verdict("gan ja")).toBe("block"));
  it.fails("mercury thermometer (hazardous, only 'mercury metal/liquid' matches)", () => expect(verdict("mercury thermometer")).not.toBe("allow"));
  it.fails("false positive: colour 'ivory white paint' should not be blocked as wildlife", () => expect(verdict("ivory white paint")).not.toBe("block"));
  it.fails("false positive: 'bomb calorimeter' lab instrument", () => expect(verdict("bomb calorimeter")).not.toBe("block"));
});
