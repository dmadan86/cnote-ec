import { describe, expect, it } from "vitest";
import { cleanVariants, tokens, variantForms } from "../src/retrieval";

describe("retrieval token helpers", () => {
  it("keeps Indic vowel signs inside words and drops punctuation", () => {
    expect(tokens("कपड़ा, धागा! cotton-yarn")).toEqual(["कपड़ा", "धागा", "cotton", "yarn"]);
  });
  it("drops 1-char tokens, dedupes and caps at 12", () => {
    expect(tokens("a a bb bb")).toEqual(["bb"]);
    expect(tokens(Array.from({ length: 20 }, (_, i) => `w${i}x`).join(" "))).toHaveLength(12);
  });
  it("cleanVariants drops blanks, duplicates, the original and token-less strings, caps at 6 and 300 chars", () => {
    expect(cleanVariants("Cotton", ["cotton", " ", "!!", "kapas", "KAPAS", "कपास"])).toEqual(["kapas", "कपास"]);
    expect(cleanVariants("x", undefined)).toEqual([]);
    expect(cleanVariants("x", Array.from({ length: 10 }, (_, i) => `variant${i}`))).toHaveLength(6);
    expect(cleanVariants("x", ["a".repeat(500)])[0]).toHaveLength(300);
  });
  it("variantForms are exact: itself, +s and -s (no prefixes)", () => {
    expect(variantForms("chair")).toEqual(["chair", "chairs"]);
    expect(variantForms("tiles")).toEqual(["tiles", "tiless", "tile"]);
    expect(variantForms("gas")).toEqual(["gas", "gass"]);
    expect(variantForms("batte")).not.toContain("battery");
  });
});
