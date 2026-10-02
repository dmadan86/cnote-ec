import type { Metadata } from "next";
import Link from "next/link";
import { Heart } from "lucide-react";
import { buttonClasses, Container, EmptyState, Grid, PageHeader } from "@cnote/ui";
import { getSharedWishlist } from "@cnote/wishlist";
import { getTranslations } from "next-intl/server";
import { ListingCard } from "@/features/search/cards";
import { getRequestLocale } from "@/lib/request-locale";

// A wishlist shared through its read-only link. Anonymous visitors can open it; it shows the list name and public product
// facts only (no owner, notes, saved prices or contact details). Never indexed, never sent as a referrer, never cached.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "convenience" });
  return { title: t("shared.metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function SharedWishlistPage(props: PageProps<"/shared/[token]">) {
  const { token } = await props.params;
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "convenience" });
  const list = await getSharedWishlist(token);

  if (!list) {
    return (
      <Container className="py-8">
        <EmptyState
          title={t("shared.notFoundTitle")}
          description={t("shared.notFoundBody")}
          action={
            <Link href="/search" className={buttonClasses("primary")}>
              <Heart className="size-4" aria-hidden /> {t("shared.browse")}
            </Link>
          }
        />
      </Container>
    );
  }
  return (
    <Container className="py-6 lg:py-8">
      <PageHeader title={t("shared.title", { name: list.name })} description={t("shared.intro")} />
      <div className="mt-6">
        {list.listings.length ? (
          <Grid>
            {list.listings.map((l) => (
              <ListingCard key={l.id} listing={l} locale={locale} />
            ))}
          </Grid>
        ) : (
          <EmptyState title={t("shared.empty")} description="" />
        )}
      </div>
      <p className="mt-8">
        <Link href="/signin?next=/wishlist" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 hover:underline">
          {t("shared.signIn")}
        </Link>
      </p>
    </Container>
  );
}
