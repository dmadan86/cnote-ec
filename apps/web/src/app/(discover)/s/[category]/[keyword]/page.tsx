import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, Container, Grid } from "@cnote/ui";
import { JsonLd } from "@/lib/json-ld";
import { categoryPath, landingPath, slugify } from "@/lib/paths";
import { breadcrumbLd, itemListLd } from "@/lib/schema";
import { ListingCard } from "@/features/search/cards";
import { loadCategory, loadHitsStatic, loadLandingKeywords, loadRatings } from "@/features/search/data";

// Curated, indexable search landing pages: /s/<category-slug>/<keyword-slug>. Only keywords derived from live listings
// exist (allow-list); everything else 404s. Free-text /search?q= pages stay noindex.
export const revalidate = 600;

async function resolve(categorySlug: string, keywordSlug: string) {
  const [category, keywords] = await Promise.all([loadCategory(categorySlug), loadLandingKeywords()]);
  const keyword = (keywords[categorySlug] ?? []).find((k) => slugify(k, 50) === keywordSlug);
  return category && !category.prohibited && keyword ? { category, keyword } : null;
}

export async function generateStaticParams() {
  const keywords = await loadLandingKeywords();
  return Object.entries(keywords).flatMap(([category, list]) => list.slice(0, 4).map((k) => ({ category, keyword: slugify(k, 50) })));
}

export async function generateMetadata(props: PageProps<"/s/[category]/[keyword]">): Promise<Metadata> {
  const { category, keyword } = await props.params;
  const r = await resolve(category, keyword);
  if (!r) return { title: "Not found", robots: { index: false, follow: false } };
  const title = `${r.keyword.replace(/\b\w/g, (c) => c.toUpperCase())}: verified suppliers in India`;
  const description = `Compare ${r.keyword} from verified Indian suppliers in ${r.category.name.toLowerCase()}. Real prices, minimum orders and supplier trust scores.`;
  return {
    title,
    description,
    alternates: { canonical: landingPath(category, r.keyword) },
    openGraph: { title, description, type: "website", url: landingPath(category, r.keyword) },
  };
}

export default async function LandingPage(props: PageProps<"/s/[category]/[keyword]">) {
  const { category: categorySlug, keyword: keywordSlug } = await props.params;
  const r = await resolve(categorySlug, keywordSlug);
  if (!r) notFound();
  const { hits } = await loadHitsStatic({ q: r.keyword, categorySlug, limit: 24 });
  const ratings = await loadRatings(hits.map((h) => h.listing.id));
  const heading = r.keyword.replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <Container className="py-6 lg:py-8">
      <JsonLd data={[breadcrumbLd([{ name: "Home", path: "/" }, { name: r.category.name, path: categoryPath(categorySlug) }, { name: heading }]), itemListLd(heading, hits.map((h) => h.listing))]} />
      <Breadcrumbs linkComponent={Link} items={[{ label: "Home", href: "/" }, { label: r.category.name, href: categoryPath(categorySlug) }, { label: heading }]} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{heading} suppliers in India</h1>
      <p className="mt-1 text-sm text-muted">Verified suppliers of {r.keyword} in {r.category.name}. Ranked by relevance and supplier trust, never by payment.</p>
      <div className="mt-6">
        <h2 className="sr-only">Products</h2>
        <Grid>
          {hits.map((h, i) => (
            <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} rating={ratings[h.listing.id]} priority={i < 4} />
          ))}
        </Grid>
      </div>
    </Container>
  );
}
