import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { buttonClasses, Chip, Container, EmptyState, Grid, LinkTabs } from "@cnote/ui";
import { ListingCard, SellerTile } from "@/features/search/cards";
import { loadCategories, loadHits, loadSellers } from "@/features/search/data";
import { firstParam } from "@/features/search/format";

export async function generateMetadata(props: PageProps<"/search">): Promise<Metadata> {
  const q = firstParam((await props.searchParams).q);
  return { title: q ? `Results for "${q}"` : "Search" };
}

const COMING = new Set(["templates", "services"]);

function href(params: Record<string, string>) {
  const sp = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const s = sp.toString();
  return s ? `/search?${s}` : "/search";
}

export default async function SearchPage(props: PageProps<"/search">) {
  const sp = await props.searchParams;
  const q = firstParam(sp.q);
  const category = firstParam(sp.category);
  const tab = firstParam(sp.tab) || "products";
  const isSellers = tab === "manufacturers";

  const tabs = [
    { id: "products", label: tab === "ai" ? "AI Search" : "Products" },
    { id: "manufacturers", label: "Manufacturers" },
  ];

  let body: React.ReactNode;
  let count: number | null = null;

  if (COMING.has(tab)) {
    body = (
      <EmptyState
        title="This search is coming soon"
        description="Templates and business services are not available yet. Meanwhile you can search products and manufacturers."
        action={
          <Link href={href({ q, tab: "products" })} className={buttonClasses("primary")}>
            Search products
          </Link>
        }
      />
    );
  } else if (isSellers) {
    const sellers = await loadSellers({ q: q || undefined, limit: 24 });
    count = sellers.length;
    body = sellers.length ? (
      <Grid cols={3} className="grid-cols-1 sm:grid-cols-2">
        {sellers.map((s) => (
          <SellerTile key={s.businessId} seller={s} />
        ))}
      </Grid>
    ) : (
      <NoResults q={q} />
    );
  } else {
    const [{ hits, failed }, categories] = await Promise.all([loadHits({ q, categorySlug: category || undefined, limit: 24 }), loadCategories()]);
    count = hits.length;
    body = (
      <>
        {categories.length ? (
          <ul className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Filter by category">
            <li>
              <Chip href={href({ q, tab })} linkComponent={Link} selected={!category}>
                All categories
              </Chip>
            </li>
            {categories.map((c) => (
              <li key={c.id} className="shrink-0">
                <Chip href={href({ q, tab, category: c.slug })} linkComponent={Link} selected={category === c.slug}>
                  {c.name}
                </Chip>
              </li>
            ))}
          </ul>
        ) : null}
        {hits.length ? (
          <Grid>
            {hits.map((h, i) => (
              <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} priority={i < 4} />
            ))}
          </Grid>
        ) : (
          <NoResults q={q} failed={failed} />
        )}
      </>
    );
  }

  return (
    <Container className="py-6 lg:py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{q ? <>Results for &ldquo;{q}&rdquo;</> : "Search products and manufacturers"}</h1>
        {count !== null ? (
          <p className="text-sm text-muted" aria-live="polite">
            {count} {count === 1 ? "result" : "results"}
          </p>
        ) : null}
      </div>
      <form action="/search" method="get" role="search" className="mt-4 flex gap-2">
        <input type="hidden" name="tab" value={tab} />
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <label htmlFor="search-q" className="sr-only">
          Search
        </label>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search products, manufacturers, or ask anything..."
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        <button type="submit" className={buttonClasses("primary", "md", "h-11 rounded-lg px-5")}>
          Search
        </button>
      </form>
      <LinkTabs
        className="mt-4 border-b border-line"
        variant="underline"
        label="Search type"
        linkComponent={Link}
        items={tabs.map((t) => ({ href: href({ q, tab: t.id, category: t.id === "products" ? category : "" }), label: t.label, active: (t.id === "products" && !isSellers && !COMING.has(tab)) || t.id === tab }))}
      />
      <p className="mt-4 flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        Ranked by relevance and supplier trust, never by payment.
      </p>
      <div className="mt-6">{body}</div>
    </Container>
  );
}

function NoResults({ q, failed }: { q: string; failed?: boolean }) {
  return (
    <EmptyState
      title={failed ? "Search is taking a break" : q ? `No results for “${q}”` : "No products found"}
      description={failed ? "We could not load results right now. Please try again in a moment, or post your requirement and suppliers will come to you." : "Try different keywords, or describe what you need and verified suppliers will send you quotes."}
      action={
        <Link href={`/rfq/new${q ? `?q=${encodeURIComponent(q)}` : ""}`} className={buttonClasses("accent")}>
          Post your requirement
        </Link>
      }
    />
  );
}
