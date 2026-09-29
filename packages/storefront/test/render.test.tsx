import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StorefrontView, type RenderData } from "../src/render";
import { TEMPLATE_SEEDS, mergeSellerData } from "../src/templates";
import { defaultSection, blankDocument, type StorefrontDocument } from "../src/document";

const data: RenderData = {
  business: { id: "b1", name: "Acme <script>alert(1)</script> Ltd", city: "Pune", state: "Maharashtra" },
  trust: { tier: 1, score: 72, badgeActive: true, gstVerified: true },
  rating: { average: 4.6, count: 12 },
  products: [{ id: "p1", title: "Kraft box 3 ply", imageUrl: null, imageAlt: "Kraft box", pricePaise: 520, priceUnit: "pc", moq: 500, moqUnit: "pcs", categorySlug: "boxes", categoryName: "Boxes" }],
  categories: [{ slug: "boxes", name: "Boxes" }],
  testimonials: [{ id: "r1", rating: 5, title: "Great", body: "Delivered on time and quality was consistent.", authorName: "Buyer A", productTitle: "Kraft box 3 ply", verifiedEnquiry: true }],
};
const hrefs = { page: (s: string) => (s === "home" ? "/store/acme" : `/store/acme/${s}`), product: (p: { id: string }) => `/p/${p.id}`, rfq: "/rfq/new?seller=b1" };
const render = (document: StorefrontDocument, pageSlug?: string, preview = false) => renderToStaticMarkup(<StorefrontView document={document} pageSlug={pageSlug} data={data} hrefs={hrefs} preview={preview} />);

describe("renderer", () => {
  it("escapes seller-controlled text (no raw HTML injection)", () => {
    const html = render(blankDocument({ name: "x", city: null }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("always shows the platform trust strip, even when the page omits it, from live data", () => {
    const d = blankDocument({ name: "Acme", city: "Pune" });
    d.pages[0]!.sections = d.pages[0]!.sections.filter((s) => s.type !== "trustStrip");
    const html = render(d);
    expect(html).toContain("GST verified");
    expect(html).toContain("Trust score 72/100");
    expect(html).toContain("12 buyer reviews");
  });
  it("shows Unverified when the badge is not active", () => {
    const html = renderToStaticMarkup(<StorefrontView document={blankDocument({ name: "A", city: null })} data={{ ...data, trust: { tier: 2, score: 20, badgeActive: false, gstVerified: true } }} hrefs={hrefs} />);
    expect(html).toContain("Unverified");
  });
  it("renders testimonials only from platform data and RFQ CTA to the seller", () => {
    const d = blankDocument({ name: "Acme", city: "Pune" });
    d.pages[0]!.sections.push(defaultSection("testimonials", "t1"));
    const html = render(d);
    expect(html).toContain("Delivered on time");
    expect(html).toContain('href="/rfq/new?seller=b1"');
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("mailto:");
  });
  it("hides empty platform blocks live, explains them in preview", () => {
    const d = blankDocument({ name: "Acme", city: "Pune" });
    d.pages[0]!.sections.push(defaultSection("testimonials", "t1"));
    const empty = { ...data, testimonials: [] };
    const live = renderToStaticMarkup(<StorefrontView document={d} data={empty} hrefs={hrefs} />);
    const prev = renderToStaticMarkup(<StorefrontView document={d} data={empty} hrefs={hrefs} preview />);
    expect(live).not.toContain("cannot type reviews");
    expect(prev).toContain("cannot type reviews");
  });
  it("has exactly one h1 and a labelled section per titled block on every template page", () => {
    for (const t of TEMPLATE_SEEDS) {
      const merged = mergeSellerData(t.document, { name: "Acme", city: "Pune" });
      for (const p of merged.pages) {
        const html = render(merged, p.slug);
        expect((html.match(/<h1[ >]/g) ?? []).length, `${t.key}/${p.slug}`).toBe(1);
      }
    }
  });
  it("links to sub-pages through the provided href builder and marks the current page", () => {
    const t = mergeSellerData(TEMPLATE_SEEDS[0]!.document, { name: "Acme", city: "Pune" });
    const html = render(t, "products");
    expect(html).toContain('href="/store/acme/about"');
    expect(html).toContain('aria-current="page"');
  });
});
