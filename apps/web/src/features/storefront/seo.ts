import type { Metadata } from "next";
import { customDomainOrigin } from "@cnote/domains";
import { getStorefrontCanonical, type PublishedStorefront } from "@cnote/storefront";
import { findPage } from "@cnote/storefront/render";
import { productPath } from "@/lib/paths";
import { absoluteUrl } from "@/lib/site-url";

/**
 * Canonical URL for a storefront page. SEO policy: the seller's primary ACTIVE custom domain is canonical (the proxy
 * serves /<page> there); otherwise the marketplace URL /store/<slug>/<page>. Platform subdomains are never canonical,
 * so the same page is never indexed under two hosts.
 */
export async function canonicalFor(slug: string, page: string): Promise<string> {
  let custom: string | null = null;
  try {
    custom = await customDomainOrigin(slug);
  } catch (err) {
    console.error("[web] customDomainOrigin failed", err instanceof Error ? err.message : err);
  }
  if (custom) return `${custom}${page && page !== "home" ? `/${page.replace(/^\/+/, "")}` : "/"}`;
  return getStorefrontCanonical(slug, page);
}

/** Live storefronts whose canonical URL is on the marketplace (custom-domain ones belong in their own host's sitemap). */
export async function platformCanonicalStorefronts(slugs: string[]): Promise<string[]> {
  const checks = await Promise.all(slugs.map(async (slug) => ((await customDomainOrigin(slug).catch(() => null)) ? null : slug)));
  return checks.filter((s): s is string => s !== null);
}

export async function storefrontMetadata(s: PublishedStorefront, pageSlug: string): Promise<Metadata> {
  const page = findPage(s.document, pageSlug);
  const name = s.data.business.name;
  const title = page.seo.title || (page.slug === "home" ? name : `${page.title} | ${name}`);
  const description = page.seo.description || `${name}${s.data.business.city ? `, ${s.data.business.city}` : ""}: products, verification and quotes.`;
  const url = await canonicalFor(s.storefront.slug, page.slug);
  // The first hero image (approved platform media only) doubles as the share image when there is one.
  const hero = page.sections.find((x) => x.type === "hero");
  const img = hero && hero.type === "hero" && hero.image && !hero.image.src.startsWith("placeholder:") ? [{ url: absoluteUrl(hero.image.src), alt: hero.image.alt || name }] : undefined;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", title, description, url, siteName: name, locale: "en_IN", ...(img ? { images: img } : {}) },
    twitter: { card: img ? "summary_large_image" : "summary", title, description },
  };
}

type Json = Record<string, unknown>;

/** Organization + LocalBusiness (+ product ItemList and AggregateRating from approved reviews only). Only platform-verified facts. */
export async function storefrontJsonLd(s: PublishedStorefront, pageSlug: string): Promise<Json[]> {
  const { business, rating, products, trust } = s.data;
  const url = await canonicalFor(s.storefront.slug, "home");
  const org: Json = {
    "@context": "https://schema.org",
    "@type": ["Organization", "LocalBusiness"],
    "@id": `${url}#org`,
    name: business.name,
    url,
    ...(business.city || business.state
      ? { address: { "@type": "PostalAddress", ...(business.city ? { addressLocality: business.city } : {}), ...(business.state ? { addressRegion: business.state } : {}), addressCountry: "IN" } }
      : {}),
    areaServed: { "@type": "Country", name: "India" },
    additionalProperty: [
      { "@type": "PropertyValue", name: "Trust score (0-100)", value: trust.score },
      { "@type": "PropertyValue", name: "Verification tier (0-3)", value: trust.tier },
    ],
    ...(rating && rating.count > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: rating.average, reviewCount: rating.count, bestRating: 5, worstRating: 1 } } : {}),
  };
  const out: Json[] = [org];
  if (pageSlug === "home" && products.length) {
    out.push({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: products.slice(0, 12).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(productPath(p)), name: p.title })),
    });
  }
  return out;
}
