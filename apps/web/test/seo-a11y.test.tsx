import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, Input, ProductCard } from "@cnote/ui";
import { JsonLd } from "@/lib/json-ld";
import { parseProductParam, productPath, slugify } from "@/lib/paths";
import { breadcrumbLd, itemListLd, productLd } from "@/lib/schema";
import { RatingStars } from "@/features/reviews/stars";
import { SkipLink } from "@/features/shell/skip-link";
import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ID = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const listing = {
  id: ID, sellerBusinessId: "s1", category: { id: "c1", slug: "packaging", name: "Packaging" }, title: "Kraft Corrugated Box, 3 Ply & Strong", description: "Sturdy </script> box",
  attributes: { ply: 3 }, pricePaise: 1250, priceUnit: "piece", moq: 500, moqUnit: "pcs", hsn: "4819", language: "en", imageUrls: ["/media/listing-images/x"],
  aiGenerated: false, status: "published", moderationStatus: "approved", moderationReason: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
} as ListingView;
const seller = { businessId: "s1", name: "Acme Packs", city: "Surat", state: "Gujarat", pincode: "395003", verificationTier: 2, trustScore: 80, badgeActive: true, languages: ["en"] } as TrustProfile;

describe("SEO: URLs", () => {
  it("builds canonical product paths and parses them back", () => {
    expect(productPath(listing)).toBe(`/p/kraft-corrugated-box-3-ply-and-strong-${ID}`);
    expect(parseProductParam(productPath(listing).slice(3))).toEqual({ id: ID, slug: "kraft-corrugated-box-3-ply-and-strong" });
    expect(parseProductParam(ID)).toEqual({ id: ID, slug: "" });
    expect(parseProductParam("nonsense")).toBeNull();
    expect(slugify("  Café  ₹ 100 / pcs ")).toBe("cafe-100-pcs");
  });
});

describe("SEO: structured data", () => {
  it("emits Product + Offer in INR with approved-only AggregateRating", () => {
    const ld = productLd(listing, seller, { average: 4.5, count: 12 }) as Json;
    expect(ld["@type"]).toBe("Product");
    expect(ld.offers.priceCurrency).toBe("INR");
    expect(ld.offers.price).toBe("12.50");
    expect(ld.offers.seller.name).toBe("Acme Packs");
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 4.5, reviewCount: 12 });
  });
  it("omits AggregateRating when there are no approved reviews", () => {
    expect(productLd(listing, seller, null)).not.toHaveProperty("aggregateRating");
    expect(productLd(listing, seller, { average: 0, count: 0 })).not.toHaveProperty("aggregateRating");
  });
  it("builds BreadcrumbList and ItemList", () => {
    const b = breadcrumbLd([{ name: "Home", path: "/" }, { name: "X" }]) as Json;
    expect(b.itemListElement[0].item).toMatch(/\/$/);
    expect(b.itemListElement[1]).not.toHaveProperty("item");
    expect((itemListLd("t", [listing]) as Json).itemListElement[0].url).toContain("/p/");
  });
  it("escapes '<' so listing text cannot close the script tag", () => {
    const html = renderToStaticMarkup(<JsonLd data={productLd(listing, seller, null)} />);
    expect(html).not.toContain("</script> box");
    expect(html).toContain("\\u003c/script>");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("a11y: components", () => {
  it("skip link targets #main", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toMatch(/href="#main"/);
  });
  it("Field wires the error to the control (aria-describedby, aria-invalid, role=alert)", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="n" error="Required">
        <Input id="n" name="n" />
      </Field>,
    );
    expect(html).toMatch(/for="n"/);
    expect(html).toMatch(/aria-describedby="n-error"/);
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/id="n-error"[^>]*role="alert"|role="alert"[^>]*id="n-error"/);
  });
  it("Field hint is described but not marked invalid", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="n" hint="Your legal name">
        <Input id="n" />
      </Field>,
    );
    expect(html).toMatch(/aria-describedby="n-hint"/);
    expect(html).not.toMatch(/aria-invalid=/);
  });
  it("RatingStars exposes the value to assistive tech and renders nothing without reviews", () => {
    expect(renderToStaticMarkup(<RatingStars average={4.5} count={12} />)).toMatch(/role="img" aria-label="4.5 out of 5 stars"/);
    expect(renderToStaticMarkup(<RatingStars average={0} count={0} />)).toBe("");
  });
  it("ProductCard: heading with a link, decorative glyphs hidden, price and MOQ as text", () => {
    const html = renderToStaticMarkup(
      <ul>
        <ProductCard id="1" href="/p/x" title="Box" image={<span />} pricePaise={1250} priceUnit="piece" moqText="500 pcs" wishlist={<button aria-label="Save Box">s</button>} rating={<RatingStars average={4} count={2} />} />
      </ul>,
    );
    expect(html).toMatch(/<h3[^>]*><a href="\/p\/x"/);
    expect(html).toContain("Min. order: 500 pcs");
    expect(html).toContain('aria-label="Save Box"');
    expect(html).toContain("4 out of 5 stars");
  });
});

// ---- source-level guards --------------------------------------------------------------------------
const SRC = join(__dirname, "..", "src");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = walk(SRC).filter((f) => /\.(tsx?|ts)$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

describe("guards", () => {
  // The whole point of the performance design: public pages/shell never touch per-request data, so they stay static/ISR.
  const STATIC_FILES = [
    "app/layout.tsx", "app/page.tsx", "app/(discover)/c/[slug]/page.tsx", "app/(discover)/p/[slugId]/page.tsx", "app/(discover)/s/[category]/[keyword]/page.tsx",
    "app/(discover)/categories/page.tsx", "app/(discover)/manufacturers/[id]/page.tsx", "features/search/cards.tsx", "features/search/data.ts",
    "features/shell/site-header.tsx", "features/shell/site-footer.tsx", "features/reviews/public-section.tsx", "features/shell/home/popular-products.tsx", "features/shell/home/category-grid.tsx",
  ];
  it.each(STATIC_FILES)("%s stays cache-friendly (no cookies/headers/session/searchParams)", (f) => {
    const src = read(join(SRC, f));
    expect(src).not.toMatch(/from "next\/headers"/);
    expect(src).not.toMatch(/currentSession|requireSession|@cnote\/next-kit"/);
    expect(src).not.toMatch(/searchParams/);
  });

  it("no raw <img> (next/image only, with alt) and external links carry rel=noopener", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) {
      const src = read(f);
      // Only allowed as the fallback inside <picture> (pre-generated AVIF/WebP variants), and it must carry alt.
      if (src.includes("<picture>")) {
        for (const m of src.matchAll(/<img\s[\s\S]*?\/>/g)) expect(m[0], relative(SRC, f)).toMatch(/\balt=\{/);
      } else {
        expect(src, relative(SRC, f)).not.toMatch(/<img[\s>]/);
      }
      for (const m of src.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) expect(m[0], relative(SRC, f)).toMatch(/rel="[^"]*noopener/);
    }
  });

  it("private areas are never listed in sitemaps or allowed by robots.txt", () => {
    const robots = read(join(SRC, "app/robots.ts"));
    for (const p of ["/account", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare"]) expect(robots).toContain(`"${p}"`);
  });
});
