import type { MetadataRoute } from "next";
import { categoryPath, landingPath, productPath, sellerPath } from "@/lib/paths";
import { absoluteUrl } from "@/lib/site-url";
import { loadCategories, loadLandingKeywords, loadListingIndex, loadSellerIndex } from "@/features/search/data";
import { CHUNK, sitemapLayout } from "@/features/seo/sitemap-layout";
import { topStorefrontSlugs } from "@/features/storefront/data";
import { platformCanonicalStorefronts } from "@/features/storefront/seo";

// Segmented sitemaps at /sitemaps/sitemap/<id>.xml, listed by the index at /sitemap.xml (a route handler: Next only emits the per-id files, and a sitemap.ts at the app root would claim /sitemap.xml). Regenerated hourly (and when the
// `sitemap` tag is purged by listing/seller events).
export const revalidate = 3600;

export async function generateSitemaps() {
  return (await sitemapLayout()).ids.map((id) => ({ id }));
}

export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const id = Number(await props.id);
  const { kindOf } = await sitemapLayout();
  const k = kindOf(id);
  if (k.kind === "core") {
    const [categories, keywords, storefronts] = await Promise.all([
      loadCategories(),
      loadLandingKeywords(),
      topStorefrontSlugs(5000).then(platformCanonicalStorefronts),
    ]);
    const now = new Date();
    return [
      { url: absoluteUrl("/"), lastModified: now, changeFrequency: "daily", priority: 1 },
      { url: absoluteUrl("/categories"), lastModified: now, changeFrequency: "daily", priority: 0.8 },
      { url: absoluteUrl("/manufacturers"), lastModified: now, changeFrequency: "daily", priority: 0.8 },
      { url: absoluteUrl("/pricing"), lastModified: now, changeFrequency: "monthly", priority: 0.4 },
      ...categories.map((c) => ({ url: absoluteUrl(categoryPath(c.slug)), lastModified: now, changeFrequency: "daily" as const, priority: 0.8 })),
      ...Object.entries(keywords).flatMap(([cat, list]) => list.map((kw) => ({ url: absoluteUrl(landingPath(cat, kw)), lastModified: now, changeFrequency: "weekly" as const, priority: 0.6 }))),
      // Seller storefronts canonical on the marketplace (custom-domain storefronts are indexed on their own host).
      ...storefronts.map((slug) => ({ url: absoluteUrl(`/store/${slug}`), lastModified: now, changeFrequency: "weekly" as const, priority: 0.6 })),
    ];
  }
  if (k.kind === "manufacturers") {
    return (await loadSellerIndex(k.chunk * CHUNK, CHUNK)).map((s) => ({ url: absoluteUrl(sellerPath(s.businessId)), lastModified: new Date(s.createdAt), changeFrequency: "weekly" as const, priority: 0.5 }));
  }
  return (await loadListingIndex(k.chunk * CHUNK, CHUNK)).map((l) => ({ url: absoluteUrl(productPath(l)), lastModified: new Date(l.updatedAt), changeFrequency: "weekly" as const, priority: 0.7 }));
}
