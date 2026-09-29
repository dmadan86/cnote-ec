import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses, Container, EmptyState, Grid, Input, Pagination } from "@cnote/ui";
import { SellerTile } from "@/features/search/cards";
import { loadSellers } from "@/features/search/data";
import { firstParam, pageParam } from "@/features/search/format";

export const metadata: Metadata = { title: "Manufacturers and suppliers" };
const PAGE_SIZE = 24;

export default async function ManufacturersPage(props: PageProps<"/manufacturers">) {
  const sp = await props.searchParams;
  const q = firstParam(sp.q);
  const city = firstParam(sp.city);
  const page = pageParam(sp.page);
  const rows = await loadSellers({ q: q || undefined, city: city || undefined, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
  const sellers = rows.slice(0, PAGE_SIZE);
  const hrefFor = (p: number) => {
    const s = new URLSearchParams();
    if (q) s.set("q", q);
    if (city) s.set("city", city);
    if (p > 1) s.set("page", String(p));
    return `/manufacturers${s.size ? `?${s}` : ""}`;
  };

  return (
    <Container className="py-6 lg:py-8">
      <h1 className="text-2xl font-bold tracking-tight text-ink">Manufacturers and suppliers</h1>
      <p className="mt-1 text-sm text-muted">Trust-ranked by verification and track record, never by payment.</p>
      <form method="get" role="search" className="mt-5 grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
        <label className="sr-only" htmlFor="m-q">Name or product</label>
        <Input id="m-q" name="q" type="search" defaultValue={q} placeholder="Name or product" className="h-11" />
        <label className="sr-only" htmlFor="m-city">City</label>
        <Input id="m-city" name="city" defaultValue={city} placeholder="City, e.g. Tiruppur" className="h-11" />
        <button type="submit" className={buttonClasses("primary", "md", "h-11 rounded-lg px-5")}>Filter</button>
      </form>
      <div className="mt-6">
        {sellers.length ? (
          <>
            <Grid cols={3} className="grid-cols-1 sm:grid-cols-2">
              {sellers.map((s) => (
                <SellerTile key={s.businessId} seller={s} />
              ))}
            </Grid>
            <Pagination className="mt-8" page={page} hasNext={rows.length > PAGE_SIZE} hrefFor={hrefFor} linkComponent={Link} />
          </>
        ) : (
          <EmptyState
            title="No suppliers match your filters"
            description="Try a different city or keyword, or post your requirement and let suppliers come to you."
            action={<Link href={`/rfq/new${q ? `?q=${encodeURIComponent(q)}` : ""}`} className={buttonClasses("accent")}>Post your requirement</Link>}
          />
        )}
      </div>
    </Container>
  );
}
