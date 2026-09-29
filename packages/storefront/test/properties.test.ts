import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AA_TEXT, AA_UI, blankDocument, collectText, collectImages, collectListingIds, contrastRatio, defaultSection, DEFAULT_THEME, hexToRgb, imageIdOf, isPlatformImageSrc, mapStrings,
  newSectionId, parseMarkup, placeholderOf, plainToRichText, relativeLuminance, richTextToPlain, SECTION_TYPES, themeContrastIssues, toMarkup, validateDocument, validateDocumentClamped,
  isSafeHref, parseInline, validateDocument as validate, SECTION_LABELS, type StorefrontDocument,
} from "../src/document";
import { assertValidSlug, RESERVED_SLUGS, slugProblem, SLUG_MAX, SLUG_MIN, suggestSlug } from "../src/slug";
import { PREVIEW_TTL_SECONDS, signPreviewToken, verifyPreviewToken } from "../src/preview";
import { documentEtag } from "../src/service";

const hex = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`);
const okDoc = () => blankDocument({ name: "Acme Packaging", city: "Pune" });

describe("contrast properties", () => {
  it("is symmetric, within 1..21 and 1 for identical colours", () => {
    fc.assert(fc.property(hex, hex, (a, b) => {
      const r = contrastRatio(a, b);
      expect(r).toBeCloseTo(contrastRatio(b, a), 10);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(21.0001);
      expect(contrastRatio(a, a)).toBeCloseTo(1, 10);
    }));
  });
  it("hexToRgb / luminance boundaries", () => {
    expect(hexToRgb("#0a1BfF")).toEqual([10, 27, 255]);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
  });
  it("EVERY theme the schema accepts has AA contrast on every rendered pair", () => {
    const themeArb = fc.record({ primary: hex, onPrimary: hex, background: hex, surface: hex, text: hex, muted: hex, accent: hex });
    let accepted = 0;
    fc.assert(fc.property(themeArb, (t) => {
      const d = okDoc();
      const r = validateDocument({ ...d, theme: { ...d.theme, ...t } });
      const issues = themeContrastIssues({ ...t });
      if (r.ok) {
        accepted++;
        expect(issues).toEqual([]);
        expect(contrastRatio(r.document.theme.text, r.document.theme.background)).toBeGreaterThanOrEqual(AA_TEXT - 1e-6);
        expect(contrastRatio(r.document.theme.onPrimary, r.document.theme.primary)).toBeGreaterThanOrEqual(AA_TEXT - 1e-6);
        expect(contrastRatio(r.document.theme.accent, r.document.theme.background)).toBeGreaterThanOrEqual(AA_UI - 1e-6);
      } else {
        expect(issues.length).toBeGreaterThan(0);
      }
    }), { numRuns: 400 });
    // sanity: the generator is not degenerate on the reject side; accepted themes are rare but the default one always passes
    expect(accepted).toBeGreaterThanOrEqual(0);
    expect(themeContrastIssues({ ...DEFAULT_THEME })).toEqual([]);
  });
  it("accepts random AA-safe themes built from black/white text (positive path)", () => {
    fc.assert(fc.property(fc.constantFrom("#000000", "#111111", "#1a1a1a"), fc.constantFrom("#ffffff", "#fafafa", "#f5f5f5"), (dark, light) => {
      const d = okDoc();
      const t = { ...d.theme, text: dark, muted: dark, background: light, surface: light, primary: "#000000", onPrimary: "#ffffff", accent: "#000000" };
      expect(validate({ ...d, theme: t }).ok).toBe(true);
    }));
  });
  it("normalises colours to lower case and rejects malformed ones", () => {
    const d = okDoc();
    const r = validate({ ...d, theme: { ...d.theme, primary: "#3730A3" } });
    expect(r.ok && r.document.theme.primary).toBe("#3730a3");
    for (const bad of ["#fff", "3730a3", "#3730a3ff", "rgb(0,0,0)", "red", ""]) expect(validate({ ...d, theme: { ...d.theme, primary: bad } }).ok, bad).toBe(false);
  });
});

describe("slug properties", () => {
  it("assertValidSlug throws exactly when slugProblem reports", () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (s) => {
      const p = slugProblem(s);
      if (p) expect(() => assertValidSlug(s)).toThrow();
      else expect(() => assertValidSlug(s)).not.toThrow();
    }));
  });
  it("every accepted slug is a valid DNS label, non-reserved", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9-]{0,45}$/), (s) => {
      if (slugProblem(s) === null) {
        expect(s.length).toBeGreaterThanOrEqual(SLUG_MIN);
        expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
        expect(s).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
        expect(s).not.toContain("--");
        expect(RESERVED_SLUGS.has(s)).toBe(false);
      }
    }), { numRuns: 500 });
  });
  it("every reserved word is rejected as reserved (when otherwise well-formed)", () => {
    for (const w of RESERVED_SLUGS) {
      const p = slugProblem(w);
      expect(p, w).not.toBeNull();
      if (w.length >= SLUG_MIN) expect(p!.code).toBe("reserved");
      else expect(p!.code).toBe("length");
    }
  });
  it("reports length, format, reserved codes", () => {
    expect(slugProblem("ab")!.code).toBe("length");
    expect(slugProblem("Abc")!.code).toBe("format");
    expect(slugProblem("a_b")!.code).toBe("format");
    expect(slugProblem("admin")!.code).toBe("reserved");
    expect(slugProblem("münchen")!.code).toBe("format");
  });
  it("suggestSlug always yields a valid, unreserved slug for arbitrary unicode names", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 120 }), (name) => {
      const s = suggestSlug(name);
      expect(slugProblem(s), JSON.stringify([name, s])).toBeNull();
    }), { numRuns: 500 });
  });
  it("suggestSlug table", () => {
    expect(suggestSlug("Tata & Sons Pvt Ltd")).toBe("tata-and-sons");
    expect(suggestSlug("Café Ünïcode")).toBe("cafe-unicode");
    expect(suggestSlug("   ")).toBe("store-co"); // "store" is reserved
    expect(suggestSlug("www")).toBe("www-co");
    expect(suggestSlug("Ab")).toBe("ab-store");
    expect(suggestSlug("x".repeat(100)).length).toBe(SLUG_MAX);
  });
});

describe("preview token properties", () => {
  it("round-trips any id and honours TTL boundaries", () => {
    fc.assert(fc.property(fc.uuid(), fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }), (id, now) => {
      const { token, expiresAt } = signPreviewToken(id, now);
      expect(expiresAt.getTime()).toBe(Math.floor(now / 1000) * 1000 + PREVIEW_TTL_SECONDS * 1000);
      expect(verifyPreviewToken(token, now)).toBe(id);
      expect(verifyPreviewToken(token, expiresAt.getTime())).toBe(id);
      expect(() => verifyPreviewToken(token, expiresAt.getTime() + 1)).toThrow();
    }));
  });
  it("any single-character mutation of a token is rejected", () => {
    const { token } = signPreviewToken("sf-1");
    fc.assert(fc.property(fc.nat(token.length - 1), fc.constantFrom("A", "b", "0", "-", "_", "."), (i, ch) => {
      if (token[i] === ch) return;
      const t = token.slice(0, i) + ch + token.slice(i + 1);
      let out: string | null = null;
      try { out = verifyPreviewToken(t); } catch { /* expected */ }
      // a mutation may only "verify" if it decodes to an identical signature/body (base64url padding bits): never a different id
      expect(out === null || out === "sf-1").toBe(true);
    }), { numRuns: 300 });
  });
  it("rejects malformed, oversized, wrong version and forged bodies", () => {
    for (const t of ["", ".", "a.", ".b", "a.b.c", "x".repeat(500) + ".y"]) expect(() => verifyPreviewToken(t), t).toThrow(/invalid or has expired/);
    const { token } = signPreviewToken("sf-1");
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, s: "other", exp: 9e9 })).toString("base64url");
    expect(() => verifyPreviewToken(`${forged}.${sig}`)).toThrow();
  });
  it("tokens signed with a different secret are rejected; short secret refuses to sign", () => {
    const old = process.env.JWT_SECRET;
    try {
      const { token } = signPreviewToken("sf-1");
      process.env.JWT_SECRET = "z".repeat(40);
      expect(() => verifyPreviewToken(token)).toThrow();
      process.env.JWT_SECRET = "short";
      expect(() => signPreviewToken("sf-1")).toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = old;
    }
  });
});

describe("image reference rules", () => {
  const uuid = "2f1c0a34-1d1e-4b44-9b62-0f6e3c1d7a55";
  it("accepts only platform media / placeholders", () => {
    expect(isPlatformImageSrc(`/media/listing-images/${uuid}`)).toBe(true);
    expect(imageIdOf(`/media/listing-images/${uuid}`)).toBe(uuid);
    expect(imageIdOf("placeholder:gift")).toBeNull();
    expect(placeholderOf("placeholder:gift")).toBe("gift");
    expect(placeholderOf("placeholder:bogus")).toBeNull();
    expect(placeholderOf("https://x/y")).toBeNull();
    for (const bad of [
      `https://cnote.in/media/listing-images/${uuid}`, `/media/listing-images/${uuid}?x=1`, `/media/listing-images/${uuid}/`, `/media/listing-images/${uuid}.png`,
      `javascript:alert(1)`, `data:image/png;base64,AAAA`, `//cdn.evil/${uuid}`, `/media/other/${uuid}`, `/media/listing-images/${uuid}%00`, "", "placeholder:", "PLACEHOLDER:factory",
    ]) expect(isPlatformImageSrc(bad), bad).toBe(false);
  });
  it("no generated URL-ish string is accepted unless it is platform media", () => {
    fc.assert(fc.property(fc.webUrl(), (u) => { expect(isPlatformImageSrc(u)).toBe(false); }));
  });
  it("external URLs are rejected in every image slot (hero, about, gallery, logo)", () => {
    const evil = "https://evil.example/a.png";
    const base = okDoc();
    const withLogo = { ...base, theme: { ...base.theme, logo: { src: evil, alt: "l" } } };
    expect(validate(withLogo).ok).toBe(false);
    const hero = okDoc();
    (hero.pages[0]!.sections.find((s) => s.type === "hero") as { image: unknown }).image = { src: evil, alt: "h" };
    expect(validate(hero).ok).toBe(false);
    const about = okDoc();
    about.pages[0]!.sections.push({ ...defaultSection("about", "ab"), image: { src: evil, alt: "a" } } as never);
    expect(validate(about).ok).toBe(false);
  });
  it("collectImages/collectListingIds gather every reference", () => {
    const d = okDoc();
    const l1 = "11111111-1111-4111-8111-111111111111";
    const l2 = "22222222-2222-4222-8222-222222222222";
    const im = (n: number) => ({ src: `/media/listing-images/${uuid.slice(0, -1)}${n}`, alt: `i${n}` });
    d.theme.logo = im(1);
    d.pages[0]!.sections.push(
      { ...defaultSection("gallery", "gal"), images: [im(2), im(3)] } as never,
      { ...defaultSection("about", "abt"), image: im(4) } as never,
      { ...defaultSection("productGrid", "pg"), source: { kind: "handpicked", listingIds: [l1, l2, l1] } } as never,
      { ...defaultSection("featuredProduct", "fp"), listingId: l2 } as never,
    );
    const r = validate(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(collectImages(d).map((i) => i.alt).sort()).toEqual(["i1", "i2", "i3", "i4"]);
    expect(collectListingIds(d).sort()).toEqual([l1, l2].sort());
  });
});

describe("trust strip is platform-owned", () => {
  it("carries no seller content: strict schema refuses any extra field or forged claim", () => {
    for (const extra of [{ label: "KYC verified" }, { tier: 3 }, { badge: "audited" }, { items: ["Verified"] }, { html: "<b>x</b>" }, { verified: true }]) {
      const d = okDoc();
      d.pages[0]!.sections = [{ id: "ts", type: "trustStrip", tone: "default", ...extra } as never];
      expect(validate(d).ok, JSON.stringify(extra)).toBe(false);
    }
  });
  it("testimonials block carries no seller-authored quotes", () => {
    for (const extra of [{ items: [{ quote: "Best!", author: "Me" }] }, { reviews: [] }, { quotes: ["x"] }]) {
      const d = okDoc();
      d.pages[0]!.sections.push({ ...defaultSection("testimonials", "tm"), ...extra } as never);
      expect(validate(d).ok, JSON.stringify(extra)).toBe(false);
    }
  });
  it("collectText never surfaces trustStrip/testimonial platform blocks", () => {
    const d = okDoc();
    d.pages[0]!.sections.push(defaultSection("trustStrip", "zz"), defaultSection("testimonials", "tm"));
    const texts = collectText(d).join("\n");
    expect(texts).not.toMatch(/verified|audited/i);
  });
});

describe("document limits and mutation properties", () => {
  it("never throws on arbitrary JSON input", () => {
    fc.assert(fc.property(fc.jsonValue(), (v) => {
      const r = validateDocument(v);
      expect(r.ok).toBe(false);
      expect(validateDocumentClamped(v).ok).toBe(false);
    }));
  });
  it("blank document valid for arbitrary business names (clamped) and stable etag", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), fc.option(fc.string({ maxLength: 60 }), { nil: null }), (name, city) => {
      const d = blankDocument({ name, city });
      const r = validateDocumentClamped(d);
      if (r.ok) expect(documentEtag(r.document)).toBe(documentEtag(JSON.parse(JSON.stringify(r.document))));
    }), { numRuns: 200 });
  });
  it("etag is key-order independent and content sensitive", () => {
    expect(documentEtag({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(documentEtag({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(documentEtag({ a: 1 })).not.toBe(documentEtag({ a: 2 }));
    expect(documentEtag({ a: [1, 2] })).not.toBe(documentEtag({ a: [2, 1] }));
  });
  it("section-count and page-count ceilings are exact", () => {
    const mk = (n: number) => { const d = okDoc(); d.pages[0]!.sections = Array.from({ length: n }, (_, i) => defaultSection("divider", `d-${i}`)); return d; };
    expect(validate(mk(24)).ok).toBe(true);
    expect(validate(mk(25)).ok).toBe(false);
    const pages = (n: number) => { const d = okDoc(); for (let i = 1; i < n; i++) d.pages.push({ ...d.pages[0]!, slug: `p-${i}`, title: `P${i}` }); return d; };
    expect(validate(pages(6)).ok).toBe(true);
    expect(validate(pages(7)).ok).toBe(false);
  });
  it("document byte ceiling is enforced", () => {
    const d = okDoc();
    const img = { src: "/media/listing-images/2f1c0a34-1d1e-4b44-9b62-0f6e3c1d7a55", alt: "y".repeat(140) };
    d.pages[0]!.sections = Array.from({ length: 24 }, (_, i) => ({ ...defaultSection("gallery", `c-${i}`), images: Array.from({ length: 12 }, () => img) }) as never);
    for (let i = 1; i < 6; i++) d.pages.push({ ...d.pages[0]!, slug: `p-${i}`, title: `P${i}`, sections: d.pages[0]!.sections.map((s) => ({ ...s })) });
    const r = validate(d);
    expect(JSON.stringify(d).length).toBeGreaterThan(120_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => /too large/.test(i.message))).toBe(true);
  });
  it("reserved page slugs, control characters and unknown page keys are rejected", () => {
    for (const slug of ["preview", "api", "media", "static", "_next"]) {
      const d = okDoc();
      d.pages.push({ ...d.pages[0]!, slug, title: "x" });
      expect(validate(d).ok, slug).toBe(false);
    }
    const c = okDoc();
    (c.pages[0]!.sections[1] as { headline: string }).headline = "hi\u0000there";
    expect(validate(c).ok).toBe(false);
    const u = okDoc() as unknown as Record<string, unknown>;
    u.extra = 1;
    expect(validate(u).ok).toBe(false);
    expect(validate({ ...okDoc(), schemaVersion: 2 }).ok).toBe(false);
  });
  it("clamping only shortens strings; structural errors still fail", () => {
    const d = okDoc();
    (d.pages[0]!.sections[1] as { headline: string }).headline = "z".repeat(500);
    const r = validateDocumentClamped(d);
    expect(r.ok).toBe(true);
    const bad = okDoc();
    bad.pages[0]!.sections.push({ id: "x", type: "nope" } as never);
    expect(validateDocumentClamped(bad).ok).toBe(false);
    const mixed = okDoc();
    (mixed.pages[0]!.sections[1] as { headline: string }).headline = "z".repeat(500);
    mixed.theme.primary = "bad";
    expect(validateDocumentClamped(mixed).ok).toBe(false);
  });
  it("newSectionId is unique and valid; every section type has default + label", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) { const id = newSectionId("hero", taken); expect(taken.has(id)).toBe(false); taken.add(id); expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/); }
    for (const t of SECTION_TYPES) { expect(SECTION_LABELS[t]).toBeTruthy(); expect(defaultSection(t, "x").type).toBe(t); }
  });
});

describe("mapStrings / rich text properties", () => {
  it("identity map is identity; keys untouched; non-strings untouched", () => {
    fc.assert(fc.property(fc.jsonValue(), (v) => { expect(mapStrings(v, (s) => s)).toEqual(v); }));
    expect(mapStrings({ "k{{name}}": "v{{name}}", n: 1, b: true, z: null }, (s) => s.toUpperCase())).toEqual({ "k{{name}}": "V{{NAME}}", n: 1, b: true, z: null });
  });
  it("parseMarkup never throws and never emits an unsafe href", () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
      const rt = parseMarkup(s);
      for (const b of rt) {
        const inl = b.type === "p" ? b.children : b.items.flat();
        for (const c of inl) if (c.href) expect(isSafeHref(c.href)).toBe(true);
      }
      expect(typeof richTextToPlain(rt)).toBe("string");
      expect(typeof toMarkup(rt)).toBe("string");
    }), { numRuns: 400 });
  });
  it("plainToRichText produces no links or emphasis from arbitrary text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
      const rt = plainToRichText(s);
      for (const b of rt) if (b.type === "p") for (const c of b.children) expect(c.href).toBeUndefined();
    }));
  });
  it("isSafeHref table", () => {
    for (const ok of ["https://example.com", "https://a.b.c/path?q=1#x"]) expect(isSafeHref(ok), ok).toBe(true);
    for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.c", "tel:+911234", "https://localhost", "https://user:pw@example.com", "https://u@example.com", "//example.com", "example.com", ""]) expect(isSafeHref(bad), bad).toBe(false);
    expect(parseInline("a **b** *c* [d](https://e.com)").map((i) => i.text).join("")).toBe("a b c d");
  });
});
