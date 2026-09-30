import { describe, expect, it } from "vitest";
import {
  blankDocument, collectImages, collectText, contrastRatio, defaultSection, isPlatformImageSrc, mapStrings, parseMarkup, plainToRichText, richTextToPlain, SECTION_TYPES,
  storefrontJsonSchema, themeContrastIssues, toMarkup, validateDocument, validateDocumentClamped, DEFAULT_THEME, type StorefrontDocument,
} from "../src/document";
import { mergeSellerData, TEMPLATE_SEEDS } from "../src/templates";
import { assertValidSlug, slugProblem, suggestSlug } from "../src/slug";
import { signPreviewToken, verifyPreviewToken } from "../src/preview";

const okDoc = () => blankDocument({ name: "Acme Packaging", city: "Pune" });

describe("contrast", () => {
  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
  it("flags every failing pair", () => {
    const issues = themeContrastIssues({ ...DEFAULT_THEME, text: "#aaaaaa" });
    expect(issues.map((i) => i.path)).toContain("theme.text");
  });
});

describe("theme validation", () => {
  it("rejects low-contrast text and unknown fonts", () => {
    const d = okDoc();
    const low = validateDocument({ ...d, theme: { ...d.theme, text: "#bbbbbb" } });
    expect(low.ok).toBe(false);
    const font = validateDocument({ ...d, theme: { ...d.theme, font: "comic-sans" } });
    expect(font.ok).toBe(false);
  });
  it("rejects button text that is unreadable on the brand colour", () => {
    const d = okDoc();
    const r = validateDocument({ ...d, theme: { ...d.theme, onPrimary: "#3730a3" } });
    expect(r.ok).toBe(false);
  });
});

describe("document schema", () => {
  it("accepts the blank document and a default block of every type", () => {
    expect(validateDocument(okDoc()).ok).toBe(true);
    const d = okDoc();
    d.pages[0]!.sections = SECTION_TYPES.map((t, i) => defaultSection(t, `s-${i}`));
    const r = validateDocument(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("is strict: unknown keys and types are rejected", () => {
    const d = okDoc() as unknown as { pages: { sections: unknown[] }[] };
    d.pages[0]!.sections.push({ id: "x", type: "script", src: "https://evil" });
    expect(validateDocument(d).ok).toBe(false);
    const e = okDoc() as unknown as { pages: { sections: Record<string, unknown>[] }[] };
    e.pages[0]!.sections[1]!.onclick = "alert(1)";
    expect(validateDocument(e).ok).toBe(false);
  });
  it("requires a home first page, unique slugs and unique section ids", () => {
    const d = okDoc();
    expect(validateDocument({ ...d, pages: [{ ...d.pages[0]!, slug: "start" }] }).ok).toBe(false);
    expect(validateDocument({ ...d, pages: [d.pages[0]!, { ...d.pages[0]!, slug: "home" }] }).ok).toBe(false);
    const dup = okDoc();
    dup.pages[0]!.sections.push({ ...dup.pages[0]!.sections[1]! });
    expect(validateDocument(dup).ok).toBe(false);
  });
  it("allows at most one trust strip per page and enforces size limits", () => {
    const d = okDoc();
    d.pages[0]!.sections.push({ id: "trust-2", type: "trustStrip", tone: "default" });
    expect(validateDocument(d).ok).toBe(false);
    const big = okDoc();
    big.pages[0]!.sections = Array.from({ length: 30 }, (_, i) => defaultSection("divider", `d-${i}`));
    expect(validateDocument(big).ok).toBe(false);
    const long = okDoc();
    (long.pages[0]!.sections[1] as { headline: string }).headline = "x".repeat(200);
    expect(validateDocument(long).ok).toBe(false);
  });
  it("only accepts platform image references (no external URLs)", () => {
    expect(isPlatformImageSrc("/media/listing-images/2f1c0a34-1d1e-4b44-9b62-0f6e3c1d7a55")).toBe(true);
    expect(isPlatformImageSrc("placeholder:factory")).toBe(true);
    expect(isPlatformImageSrc("https://evil.example/x.png")).toBe(false);
    expect(isPlatformImageSrc("//evil.example/x.png")).toBe(false);
    expect(isPlatformImageSrc("/media/listing-images/../../etc/passwd")).toBe(false);
    expect(isPlatformImageSrc("placeholder:nope")).toBe(false);
    const d = okDoc();
    d.pages[0]!.sections.push({ ...defaultSection("gallery", "g1"), type: "gallery", title: "G", tone: "default", images: [{ src: "https://cdn.example/a.jpg", alt: "a" }] } as never);
    expect(validateDocument(d).ok).toBe(false);
  });
  it("exposes only seller text for moderation, and nothing from platform blocks", () => {
    const d = okDoc();
    d.pages[0]!.sections.push(defaultSection("testimonials", "t1"));
    const texts = collectText(d as StorefrontDocument).join("\n");
    expect(texts).toContain("Acme Packaging");
    expect(collectImages(d)).toEqual([]);
  });
  it("produces a JSON Schema for AI builders", () => {
    const js = storefrontJsonSchema() as { type?: string };
    expect(js.type).toBe("object");
  });
  it("clamps over-long merged strings instead of failing", () => {
    const d = okDoc();
    (d.pages[0]!.sections[1] as { headline: string }).headline = "y".repeat(120);
    expect(validateDocument(d).ok).toBe(false);
    const r = validateDocumentClamped(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.document.pages[0]!.sections[1] as { headline: string }).headline.length).toBeLessThanOrEqual(90);
  });
});

describe("rich text", () => {
  it("parses the markup subset", () => {
    const rt = parseMarkup("Hello **bold** and *italic* and [site](https://example.com)\n\n- one\n- two\n\n1. first\n2. second");
    expect(rt.map((b) => b.type)).toEqual(["p", "ul", "ol"]);
    expect(richTextToPlain(rt)).toContain("Hello bold and italic and site");
    expect(toMarkup(rt)).toContain("[site](https://example.com)");
  });
  it("never yields a live javascript:/data: link", () => {
    const rt = parseMarkup("[x](javascript:alert(1)) [y](data:text/html;base64,AAA) [z](http://plain.example.com)");
    const links = rt.flatMap((b) => (b.type === "p" ? b.children : [])).filter((c) => c.href);
    expect(links).toEqual([]);
  });
  it("plainToRichText strips markup characters", () => {
    expect(richTextToPlain(plainToRichText("a *b* [c]"))).toBe("a b c");
  });
});

describe("slugs", () => {
  it("enforces length, format and reserved words", () => {
    for (const s of ["ab", "www", "admin", "studio", "store", "-abc", "abc-", "A-B-C", "a b c", "abc--def", "x".repeat(41)]) expect(slugProblem(s), s).not.toBeNull();
    for (const s of ["abc", "sri-lakshmi-pack", "a1b2c3", "x".repeat(40)]) expect(slugProblem(s), s).toBeNull();
    expect(() => assertValidSlug("www")).toThrow();
  });
  it("suggests valid slugs from business names", () => {
    expect(suggestSlug("Sri Lakshmi Packaging Pvt. Ltd.")).toBe("sri-lakshmi-packaging");
    expect(suggestSlug("श्री गणेश")).toMatch(/^[a-z0-9-]{3,40}$/);
    expect(slugProblem(suggestSlug("Admin"))).toBeNull();
    expect(slugProblem(suggestSlug("A"))).toBeNull();
    expect(slugProblem(suggestSlug("R&D Works & Co, " + "x".repeat(80)))).toBeNull();
  });
});

describe("preview tokens", () => {
  it("round-trips, expires and rejects tampering", () => {
    const { token } = signPreviewToken("sf-1");
    expect(verifyPreviewToken(token)).toBe("sf-1");
    const [tokBody, tokSig] = token.split(".");
    expect(Buffer.from(aliasLastChar(tokSig!), "base64url").equals(Buffer.from(tokSig!, "base64url"))).toBe(true);
    expect(() => verifyPreviewToken(`${tokBody}.${aliasLastChar(tokSig!)}`)).toThrow(); // non-canonical spelling rejected
    expect(() => verifyPreviewToken(token, Date.now() + 31 * 60_000)).toThrow();
    const [b, s] = token.split(".");
    expect(() => verifyPreviewToken(`${b}x.${s}`)).toThrow();
    expect(() => verifyPreviewToken("garbage")).toThrow();
  });
});

describe("curated templates", () => {
  it("ships the six templates, each valid and AA-compliant", () => {
    expect(TEMPLATE_SEEDS.map((t) => t.key)).toEqual(["industrial-classic", "packaging-bold", "textile-heritage", "minimal-catalogue", "modern-trust", "gifting-festive"]);
    for (const t of TEMPLATE_SEEDS) {
      const r = validateDocument(t.document);
      expect(r.ok, `${t.key}: ${JSON.stringify(r)}`).toBe(true);
      expect(themeContrastIssues(t.document.theme), t.key).toEqual([]);
      const home = t.document.pages[0]!;
      expect(home.sections.some((s) => s.type === "trustStrip"), `${t.key} trust strip`).toBe(true);
      expect(home.sections.some((s) => s.type === "hero")).toBe(true);
    }
  });
  it("merges the seller's real data, with a fallback when there is no city", () => {
    const t = TEMPLATE_SEEDS[0]!.document;
    const m = mergeSellerData(t, { name: "Ravi Engineering", city: "Rajkot" });
    expect(JSON.stringify(m)).not.toContain("{{");
    expect(JSON.stringify(m)).toContain("Ravi Engineering");
    expect(JSON.stringify(mergeSellerData(t, { name: "Ravi", city: null }))).toContain("India");
    const long = validateDocumentClamped(mergeSellerData(t, { name: "A Very Long Registered Business Name Industries Private Limited Company", city: "Thiruvananthapuram" }));
    expect(long.ok).toBe(true);
    expect(mapStrings({ a: ["x"] }, (s) => s + "!")).toEqual({ a: ["x!"] });
  });
});

/** Same signature bytes, different base64url spelling (flips an unused padding bit of the last character). */
function aliasLastChar(sig: string): string {
  const AB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return sig.slice(0, -1) + AB[AB.indexOf(sig.at(-1)!) ^ 1]!;
}
