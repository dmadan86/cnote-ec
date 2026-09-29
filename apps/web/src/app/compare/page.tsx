import type { Metadata } from "next";
import Link from "next/link";
import { Scale } from "lucide-react";
import { getCategoryBySlug, type ListingView } from "@cnote/catalogue";
import { getTrustProfiles, type TrustProfile } from "@cnote/identity";
import { buttonClasses, Container, EmptyState, PageHeader } from "@cnote/ui";
import { parseCompareIds } from "@cnote/wishlist";
import { CompareTable } from "@/features/compare/compare-table";
import { loadCompareListings, readCompareIds } from "@/features/compare/state";
import { safe } from "@/features/search/data";
import { firstParam } from "@/features/search/format";
import { loadSavedState } from "@/features/wishlist/saved";

export const metadata: Metadata = { title: "Compare products", robots: { index: false } };

export default async function ComparePage(props: PageProps<"/compare">) {
  const sp = await props.searchParams;
  // /compare?ids=a,b,c is a shareable link and works without cookies; otherwise use the tray.
  const shared = firstParam(sp.ids);
  const ids = shared ? parseCompareIds(shared) : await readCompareIds();
  const all = await loadCompareListings(ids);

  // Only products of the first product's category can be compared (attributes differ across categories).
  const categoryId = all[0]?.category.id;
  const listings: ListingView[] = all.filter((l) => l.category.id === categoryId);
  const skipped = all.length - listings.length;

  const [category, sellers, { signedIn, saved }] = await Promise.all([
    listings[0] ? safe("catalogue.getCategoryBySlug", () => getCategoryBySlug(listings[0]!.category.slug), null) : null,
    safe("identity.getTrustProfiles", () => getTrustProfiles([...new Set(listings.map((l) => l.sellerBusinessId))]), new Map<string, TrustProfile>()),
    loadSavedState(),
  ]);
  // TODO(reviews): show a rating row via getRatingSummaries(listingIds) from @cnote/reviews once it ships.

  return (
    <Container className="py-6 lg:py-8">
      <PageHeader
        title="Compare products"
        description={listings[0] ? `Side-by-side in ${listings[0].category.name}. Differences are highlighted.` : "Add up to 4 products from the same category to compare them."}
      />
      {listings.length < 2 ? (
        <div className="mt-6">
          <EmptyState
            title={listings.length === 1 ? "Add one more product to compare" : "Nothing to compare yet"}
            description="Use the Compare button on any product to add it here. You can compare up to 4 products from the same category."
            action={
              <Link href="/search" className={buttonClasses("primary")}>
                <Scale className="size-4" aria-hidden /> Browse products
              </Link>
            }
          />
        </div>
      ) : null}
      {listings.length ? (
        <div className="mt-6">
          {skipped > 0 ? <p className="mb-3 rounded-lg bg-canvas px-3 py-2 text-sm text-muted">{skipped} product(s) from other categories were left out: specifications differ between categories.</p> : null}
          <CompareTable
            listings={listings}
            sellers={Object.fromEntries(sellers)}
            fields={category?.attributeSchema.fields ?? []}
            savedIds={[...saved]}
            signedIn={signedIn}
            shared={!!shared}
            ids={listings.map((l) => l.id)}
          />
        </div>
      ) : null}
    </Container>
  );
}
