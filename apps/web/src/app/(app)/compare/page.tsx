import type { Metadata } from "next";
import Link from "next/link";
import { Scale } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getRequestLocale } from "@/lib/request-locale";
import { getCategoryBySlug, type ListingView } from "@cnote/catalogue";
import { getTrustProfiles, type TrustProfile } from "@cnote/identity";
import { buttonClasses, Container, EmptyState, PageHeader } from "@cnote/ui";
import { parseCompareIds } from "@cnote/wishlist";
import { CompareTable } from "@/features/compare/compare-table";
import { loadCompareListings, readCompareIds } from "@/features/compare/state";
import { loadRatings, safe } from "@/features/search/data";
import { firstParam } from "@/features/search/format";
import { loadSavedState } from "@/features/wishlist/saved";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("compare"), robots: { index: false, follow: false } };
}

export default async function ComparePage(props: PageProps<"/compare">) {
  const sp = await props.searchParams;
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "compare" });
  // /compare?ids=a,b,c is a shareable link and works without cookies; otherwise use the tray.
  const shared = firstParam(sp.ids);
  const ids = shared ? parseCompareIds(shared) : await readCompareIds();
  const all = await loadCompareListings(ids);

  // Only products of the first product's category can be compared (attributes differ across categories).
  const categoryId = all[0]?.category.id;
  const listings: ListingView[] = all.filter((l) => l.category.id === categoryId);
  const skipped = all.length - listings.length;

  const [category, sellers, { signedIn, saved }, ratings] = await Promise.all([
    listings[0] ? safe("catalogue.getCategoryBySlug", () => getCategoryBySlug(listings[0]!.category.slug), null) : null,
    safe("identity.getTrustProfiles", () => getTrustProfiles([...new Set(listings.map((l) => l.sellerBusinessId))]), new Map<string, TrustProfile>()),
    loadSavedState(),
    loadRatings(listings.map((l) => l.id)),
  ]);

  return (
    <Container className="py-6 lg:py-8">
      <PageHeader
        title={t("title")}
        description={listings[0] ? t("descIn", { category: listings[0].category.name }) : t("descEmpty")}
      />
      {listings.length < 2 ? (
        <div className="mt-6">
          <EmptyState
            title={listings.length === 1 ? t("oneMoreTitle") : t("nothingTitle")}
            description={t("emptyBody", { max: 4 })}
            action={
              <Link href="/search" className={buttonClasses("primary")}>
                <Scale className="size-4" aria-hidden /> {t("browse")}
              </Link>
            }
          />
        </div>
      ) : null}
      {listings.length ? (
        <div className="mt-6">
          {skipped > 0 ? <p className="mb-3 rounded-lg bg-canvas px-3 py-2 text-sm text-muted">{t("skipped", { count: skipped })}</p> : null}
          <CompareTable
            listings={listings}
            sellers={Object.fromEntries(sellers)}
            fields={category?.attributeSchema.fields ?? []}
            savedIds={[...saved]}
            signedIn={signedIn}
            shared={!!shared}
            ids={listings.map((l) => l.id)}
            ratings={ratings}
          />
        </div>
      ) : null}
    </Container>
  );
}
