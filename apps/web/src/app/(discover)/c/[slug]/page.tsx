import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, buttonClasses, Container, EmptyState, Grid } from "@cnote/ui";
import { JsonLd } from "@/lib/json-ld";
import { breadcrumbLd, itemListLd } from "@/lib/schema";
import { categoryPath } from "@/lib/paths";
import { ListingCard } from "@/features/search/cards";
import { loadCategories, loadCategory, loadHitsStatic, loadRatings } from "@/features/search/data";

// Category landing pages: prerendered for every category at build time, rebuilt in the background every 5 min and on
// demand when `search` / `category:<slug>` / listing tags are purged. Unknown slugs render on first request (ISR).
export const revalidate = 300;

export async function generateStaticParams() {
  return (await loadCategories()).map((c) => ({ slug: c.slug }));
}

export async function generateMetadata(props: PageProps<"/c/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const c = await loadCategory(slug);
  if (!c || c.prohibited) return { title: "Category not found", robots: { index: false, follow: false } };
  const title = `${c.name} suppliers and manufacturers in India`;
  const description = `Compare ${c.name.toLowerCase()} from verified Indian manufacturers and suppliers. See real prices and minimum order quantities, ranked by relevance and supplier trust, never by payment.`;
  return {
    title,
    description,
    alternates: { canonical: categoryPath(slug), languages: { "en-IN": categoryPath(slug) } },
    openGraph: { title, description, type: "website", url: categoryPath(slug) },
    twitter: { card: "summary", title, description },
  };
}

export default async function CategoryPage(props: PageProps<"/c/[slug]">) {
  const { slug } = await props.params;
  const category = await loadCategory(slug);
  if (!category || category.prohibited) notFound();
  const { hits } = await loadHitsStatic({ q: "", categorySlug: slug, limit: 48 });
  const ratings = await loadRatings(hits.map((h) => h.listing.id));
  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          breadcrumbLd([{ name: "Home", path: "/" }, { name: "Categories", path: "/categories" }, { name: category.name }]),
          itemListLd(`${category.name} products`, hits.map((h) => h.listing)),
        ]}
      />
      <Breadcrumbs linkComponent={Link} items={[{ label: "Home", href: "/" }, { label: "Categories", href: "/categories" }, { label: category.name }]} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{category.name}</h1>
      <p className="mt-1 text-sm text-muted">
        {hits.length ? `${hits.length} products from verified suppliers. ` : ""}Ranked by relevance and supplier trust, never by payment.
      </p>
      <div className="mt-6">
        {hits.length ? (
          <>
            <h2 className="sr-only">Products in {category.name}</h2>
            <Grid>
              {hits.map((h, i) => (
              <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} rating={ratings[h.listing.id]} priority={i < 4} />
              ))}
            </Grid>
          </>
        ) : (
          <EmptyState
            title="No products in this category yet"
            description="Tell us what you need and verified suppliers will get back to you with quotes."
            action={<Link href={`/rfq/new?q=${encodeURIComponent(category.name)}`} className={buttonClasses("accent")}>Post your requirement</Link>}
          />
        )}
      </div>
    </Container>
  );
}
