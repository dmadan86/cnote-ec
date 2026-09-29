import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blankDocument, defaultSection, SECTION_TYPES, type StorefrontDocument } from "../src/document";
import { StorefrontView, findPage } from "../src/render/view";
import { formatRupees, headingId, rgba, themeVars, trustLabel } from "../src/render/util";
import { STOREFRONT_CSS } from "../src/render/css";
import type { RenderData } from "../src/render/types";

const data = (over: Partial<RenderData> = {}): RenderData => ({
  business: { id: "b1", name: "Acme <Packaging>", city: "Pune", state: "MH" },
  trust: { tier: 2, score: 70, badgeActive: true, gstVerified: true },
  rating: { average: 4.6, count: 12 },
  products: [
    { id: "p1", title: "Corrugated Box", imageUrl: "/media/listing-images/2f1c0a34-1d1e-4b44-9b62-0f6e3c1d7a55", imageAlt: "Box", pricePaise: 125000, priceUnit: "piece", moq: 100, moqUnit: "pieces", categorySlug: "boxes", categoryName: "Boxes" },
    { id: "p2", title: "Tape", imageUrl: null, imageAlt: "Tape", pricePaise: null, priceUnit: null, moq: null, moqUnit: null, categorySlug: "tapes", categoryName: "Tapes" },
  ],
  categories: [{ slug: "boxes", name: "Boxes" }, { slug: "tapes", name: "Tapes" }],
  testimonials: [{ id: "r1", rating: 5, title: "Great", body: "Delivered on time, quality was excellent.", authorName: "Ravi", productTitle: "Corrugated Box", verifiedEnquiry: true }],
  ...over,
});
const hrefs = { page: (s: string) => (s === "home" ? "/store/acme" : `/store/acme/${s}`), product: (p: { id: string }) => `/p/${p.id}`, rfq: "/rfq?seller=b1" };
const render = (doc: StorefrontDocument, d = data(), pageSlug?: string, preview = false) => renderToStaticMarkup(<StorefrontView document={doc} data={d} hrefs={hrefs} pageSlug={pageSlug} preview={preview} />);

const fullDoc = (): StorefrontDocument => {
  const d = blankDocument({ name: "Acme", city: "Pune" });
  d.pages[0]!.sections = SECTION_TYPES.map((t, i) => defaultSection(t, `s-${i}`));
  return d;
};

describe("renderer", () => {
  it("renders every section type without throwing, escaping seller/platform text", () => {
    const html = render(fullDoc());
    expect(html).toContain('class="sf"');
    expect(html).not.toContain("Acme <Packaging>");
    expect(html).toContain("Acme &lt;Packaging&gt;");
    expect(html).toContain("/store/acme");
  });
  it("renders in preview mode and with empty platform data", () => {
    const empty = data({ products: [], categories: [], testimonials: [], rating: null, trust: { tier: 0, score: 0, badgeActive: false, gstVerified: false } });
    const doc = fullDoc();
    expect(() => render(doc, empty, undefined, true)).not.toThrow();
    expect(() => render(doc, empty)).not.toThrow();
    expect(render(doc, empty)).toContain("Unverified");
  });
  it("ALWAYS shows the platform trust strip, even if the seller's page omits it", () => {
    const d = blankDocument({ name: "Acme", city: "Pune" });
    d.pages[0]!.sections = d.pages[0]!.sections.filter((s) => s.type !== "trustStrip");
    expect(d.pages[0]!.sections.some((s) => s.type === "trustStrip")).toBe(false);
    const html = render(d);
    expect(html).toContain('aria-label="Verified by the platform"');
    expect(html).toContain('id="sf-platform-trust"');
    expect(html.indexOf('id="sf-platform-trust"')).toBeLessThan(html.indexOf('id="sf-s-1"') === -1 ? Infinity : html.indexOf('id="sf-s-1"'));
  });
  it("trust label reflects the real tier only; unbadged or tier 0 is Unverified", () => {
    expect(trustLabel({ tier: 0, score: 90, badgeActive: true, gstVerified: false })).toEqual({ label: "Unverified", verified: false });
    expect(trustLabel({ tier: 3, score: 90, badgeActive: false, gstVerified: true })).toEqual({ label: "Unverified", verified: false });
    expect(trustLabel({ tier: 1, score: 0, badgeActive: true, gstVerified: true }).label).toBe("GST verified");
    expect(trustLabel({ tier: 2, score: 0, badgeActive: true, gstVerified: true }).label).toBe("KYC verified");
    expect(trustLabel({ tier: 3, score: 0, badgeActive: true, gstVerified: true }).label).toBe("Audited");
    expect(trustLabel({ tier: 9, score: 0, badgeActive: true, gstVerified: true }).label).toBe("Audited");
  });
  it("testimonials render only platform-provided reviews", () => {
    const html = render(fullDoc());
    expect(html).toContain("Delivered on time");
    const none = render(fullDoc(), data({ testimonials: [] }));
    expect(none).not.toContain("Delivered on time");
  });
  it("navigation, unknown page fallback and single h1", () => {
    const d = fullDoc();
    d.pages.push({ ...d.pages[0]!, slug: "about", title: "About us", sections: [defaultSection("about", "ab")] });
    expect(render(d, data(), "about")).toContain('data-storefront-page="about"');
    expect(render(d, data(), "nope")).toContain('data-storefront-page="home"');
    expect(findPage(d, undefined).slug).toBe("home");
    expect(render(d)).toContain('aria-label="Store pages"');
    expect((render(d).match(/<h1/g) ?? []).length).toBe(1);
    const noHero = blankDocument({ name: "A", city: null });
    noHero.pages[0]!.sections = [defaultSection("about", "ab")];
    expect((render(noHero).match(/<h1/g) ?? []).length).toBe(1);
  });
  it("renders each product source kind and logo", () => {
    const d = fullDoc();
    d.theme.logo = { src: "placeholder:factory", alt: "logo" };
    const grid = { ...defaultSection("productGrid", "pgc"), source: { kind: "category", categorySlug: "boxes" } } as never;
    const hp = { ...defaultSection("productGrid", "pgh"), source: { kind: "handpicked", listingIds: ["11111111-1111-4111-8111-111111111111", "p2"] } } as never;
    const fp = { ...defaultSection("featuredProduct", "fpx"), listingId: "p1" } as never;
    d.pages[0]!.sections.push(grid, hp, fp);
    const html = render(d);
    expect(html).toContain("Corrugated Box");
    expect(html).toContain("₹1,250");
  });
});

describe("render util", () => {
  it("formats rupees Indian-style", () => {
    expect(formatRupees(125000)).toBe("₹1,250");
    expect(formatRupees(520)).toBe("₹5.2");
    expect(formatRupees(123456789)).toBe("₹12,34,567.89");
  });
  it("rgba/themeVars/headingId/css", () => {
    expect(rgba("#ff8000", 0.5)).toBe("rgba(255,128,0,0.5)");
    const v = themeVars(blankDocument({ name: "A" }).theme) as Record<string, string>;
    expect(v["--sf-primary"]).toMatch(/^#/);
    expect(v["--sf-r"]).toMatch(/px$/);
    expect(headingId("x")).toBe("sf-h-x");
    expect(STOREFRONT_CSS).not.toMatch(/@import|url\(http|expression\(/);
  });
});
