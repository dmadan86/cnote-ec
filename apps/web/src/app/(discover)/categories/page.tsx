import type { Metadata } from "next";
import Link from "next/link";
import { Container, EmptyState, buttonClasses } from "@cnote/ui";
import { CategoryIcon } from "@/features/search/category-icon";
import { loadCategories } from "@/features/search/data";

export const metadata: Metadata = { title: "All categories" };

export default async function CategoriesPage() {
  const categories = await loadCategories();
  return (
    <Container className="py-6 lg:py-8">
      <h1 className="text-2xl font-bold tracking-tight text-ink">All categories</h1>
      <p className="mt-1 text-sm text-muted">Browse products from verified suppliers by category.</p>
      <div className="mt-6">
        {categories.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((c) => (
              <li key={c.id}>
                <Link href={`/categories/${c.slug}`} className="flex h-full items-center gap-3 rounded-card border border-line bg-surface p-4 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-600">
                  <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                    <CategoryIcon name={c.icon} className="size-6" />
                  </span>
                  <span className="text-sm font-semibold text-ink">{c.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No categories yet" description="Categories will appear once the catalogue is set up." action={<Link href="/rfq/new" className={buttonClasses("accent")}>Post your requirement</Link>} />
        )}
      </div>
    </Container>
  );
}
