import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLd } from "@/lib/json-ld";
import { loadStorefront, topStorefrontSlugs } from "@/features/storefront/data";
import { StorefrontPage } from "@/features/storefront/renderer";
import { storefrontJsonLd, storefrontMetadata } from "@/features/storefront/seo";

// Static + ISR: top live storefronts are prerendered, the rest on first request. Purged by the tag `storefront:<slug>`
// (publish, staff review, suspension, trust / listing / review changes) through POST /api/revalidate.
export const revalidate = 300;

export async function generateStaticParams() {
  return (await topStorefrontSlugs(50)).map((slug) => ({ slug }));
}

export async function generateMetadata(props: PageProps<"/store/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const s = await loadStorefront(slug);
  if (!s) return { title: "Store not found", robots: { index: false, follow: false } };
  return storefrontMetadata(s, "home");
}

export default async function StoreHome(props: PageProps<"/store/[slug]">) {
  const { slug } = await props.params;
  const s = await loadStorefront(slug);
  if (!s) notFound();
  return (
    <>
      <JsonLd data={await storefrontJsonLd(s, "home")} />
      <StorefrontPage slug={s.storefront.slug} document={s.document} pageSlug="home" data={s.data} />
    </>
  );
}
