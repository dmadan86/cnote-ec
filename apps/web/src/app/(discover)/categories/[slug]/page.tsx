import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, buttonClasses, Container, EmptyState, Grid } from "@cnote/ui";
import { ListingCard } from "@/features/search/cards";
import { loadCategory, loadHits } from "@/features/search/data";

export async function generateMetadata(props: PageProps<"/categories/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const c = await loadCategory(slug);
  return { title: c && !c.prohibited ? c.name : "Category" };
}

export default async function CategoryPage(props: PageProps<"/categories/[slug]">) {
  const { slug } = await props.params;
  const category = await loadCategory(slug);
  if (!category || category.prohibited) notFound();
  const { hits } = await loadHits({ q: "", categorySlug: slug, limit: 48 });
  return (
    <Container className="py-6 lg:py-8">
      <Breadcrumbs linkComponent={Link} items={[{ label: "Home", href: "/" }, { label: "Categories", href: "/categories" }, { label: category.name }]} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{category.name}</h1>
      <p className="mt-1 text-sm text-muted">Ranked by relevance and supplier trust, never by payment.</p>
      <div className="mt-6">
        {hits.length ? (
          <Grid>
            {hits.map((h, i) => (
              <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} priority={i < 4} />
            ))}
          </Grid>
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
