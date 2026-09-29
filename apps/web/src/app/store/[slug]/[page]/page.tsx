import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLd } from "@/lib/json-ld";
import { loadStorefront } from "@/features/storefront/data";
import { StorefrontPage } from "@/features/storefront/renderer";
import { storefrontJsonLd, storefrontMetadata } from "@/features/storefront/seo";

export const revalidate = 300;

// Sub-pages render on first request and are then cached (ISR) under the same `storefront:<slug>` tag.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata(props: PageProps<"/store/[slug]/[page]">): Promise<Metadata> {
  const { slug, page } = await props.params;
  const s = await loadStorefront(slug);
  if (!s || !s.document.pages.some((p) => p.slug === page)) return { title: "Page not found", robots: { index: false, follow: false } };
  return storefrontMetadata(s, page);
}

export default async function StorePage(props: PageProps<"/store/[slug]/[page]">) {
  const { slug, page } = await props.params;
  const s = await loadStorefront(slug);
  // "home" is the canonical root; /store/<slug>/home is not a real URL
  if (!s || page === "home" || !s.document.pages.some((p) => p.slug === page)) notFound();
  return (
    <>
      <JsonLd data={await storefrontJsonLd(s, page)} />
      <StorefrontPage slug={s.storefront.slug} document={s.document} pageSlug={page} data={s.data} />
    </>
  );
}
