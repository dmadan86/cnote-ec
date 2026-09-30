import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { MapPin } from "lucide-react";
import { Avatar, Breadcrumbs, buttonClasses, Card, CardBody, Container, EmptyState, Grid, SectionHeader, TrustBadge } from "@cnote/ui";
import { localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { isUuid, sellerPath } from "@/lib/paths";
import { breadcrumbLd, sellerLd } from "@/lib/schema";
import { localizedAlternates } from "@/lib/seo-i18n";
import { ListingCard } from "@/features/search/cards";
import { loadRatings, loadSeller, loadSellerIndex, loadSellerListings } from "@/features/search/data";
import { getUiLabels } from "@/features/search/labels";
import { loadOffers } from "@/features/promotions/data";
import { stateLabel } from "@/features/identity/states";

// Static + ISR like product pages: top sellers prerendered, the rest on first request; purged by seller:<id> / seller-listings:<id>.
export const revalidate = 300;

export async function generateStaticParams() {
  return (await loadSellerIndex(0, 50)).map((s) => ({ id: s.businessId }));
}

export async function generateMetadata(props: PageProps<"/[locale]/manufacturers/[id]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { id } = await props.params;
  const t = await getTranslations({ locale, namespace: "manufacturer" });
  const ui = await getUiLabels(locale);
  const s = isUuid(id) ? await loadSeller(id) : null;
  if (!s) return { title: t("notFound"), robots: { index: false, follow: false } };
  const place = [s.city, s.state].filter(Boolean).join(", ");
  const title = `${s.name}${place ? `, ${place}` : ""}`;
  const description = t("description", { name: s.name, place: place ? t("in", { place }) : "", tier: ui.tierName(s.verificationTier).toLowerCase(), score: s.trustScore });
  const alternates = localizedAlternates(sellerPath(id), locale);
  return { title, description, alternates, openGraph: { title, description, type: "profile", url: alternates.canonical }, twitter: { card: "summary", title, description } };
}

export default async function ManufacturerPage(props: PageProps<"/[locale]/manufacturers/[id]">) {
  const locale = await resolveLocale(props.params);
  const { id } = await props.params;
  const t = await getTranslations({ locale, namespace: "manufacturer" });
  const tm = await getTranslations({ locale, namespace: "manufacturers" });
  const tp = await getTranslations({ locale, namespace: "product" });
  const ui = await getUiLabels(locale);
  if (!isUuid(id)) notFound();
  const seller = await loadSeller(id);
  if (!seller) notFound();
  const listings = await loadSellerListings(id);
  const [ratings, offers] = await Promise.all([loadRatings(listings.map((l) => l.id)), loadOffers(listings.map((l) => l.id))]);
  const place = [seller.city, await stateLabelFor(locale, seller.state)].filter(Boolean).join(", ");

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd data={[sellerLd(seller, locale), breadcrumbLd([{ name: ui.home, path: localizePath("/", locale) }, { name: tm("title"), path: localizePath("/manufacturers", locale) }, { name: seller.name }])]} />
      <Breadcrumbs linkComponent={Link} label={ui.breadcrumb} items={[{ label: ui.home, href: "/" }, { label: tm("title"), href: "/manufacturers" }, { label: seller.name }]} />
      <Card className="mt-5">
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar name={seller.name} size="lg" className="size-20 text-2xl" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{seller.name}</h1>
            {place ? (
              <p className="mt-1 inline-flex items-center gap-1 text-sm text-muted">
                <MapPin className="size-4" aria-hidden /> {place}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <TrustBadge tier={seller.verificationTier} badgeActive={seller.badgeActive} labels={ui.trust} />
              <span className="text-sm text-muted">{t("trustScore", { score: seller.trustScore })}</span>
              <span className="text-sm text-muted">{t("verificationLevel", { tier: ui.tierName(seller.verificationTier) })}</span>
              {seller.languages.length ? <span className="text-sm text-muted">{t("languages", { list: seller.languages.join(", ") })}</span> : null}
            </div>
          </div>
          <Link href="/rfq/new" className={buttonClasses("accent", "lg")}>
            {(await getTranslations({ locale, namespace: "shell" }))("requestQuote")}
          </Link>
        </CardBody>
      </Card>

      <section className="mt-10" aria-labelledby="listings">
        <SectionHeader id="listings" title={t("productsFrom", { name: seller.name })} />
        {listings.length ? (
          <Grid>
            {listings.map((l) => (
              <ListingCard key={l.id} listing={l} rating={ratings[l.id]} offer={offers[l.id]} locale={locale} />
            ))}
          </Grid>
        ) : (
          <EmptyState
            title={t("emptyTitle")}
            description={t("emptyText")}
            action={
              <Link href="/rfq/new" className={buttonClasses("accent")}>
                {tp("requestQuote")}
              </Link>
            }
          />
        )}
      </section>
    </Container>
  );
}

/** Translated state label for a stored English state name (falls back to the stored value). */
async function stateLabelFor(locale: string, name: string | null | undefined): Promise<string> {
  const ts = await getTranslations({ locale, namespace: "states" });
  return stateLabel(name, (code) => (ts.has(code) ? ts(code) : undefined));
}
