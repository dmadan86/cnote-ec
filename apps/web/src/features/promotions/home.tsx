import { ArrowRight } from "lucide-react";
import { BlurImage } from "@/features/media/blur-image";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, Grid } from "@cnote/ui";
import type { PublicPromotion } from "@cnote/promotions";
import { ListingCard } from "@/features/search/cards";
import { loadListing, loadSeller } from "@/features/search/data";
import type { Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { loadOffer, loadPromotions } from "./data";

/**
 * Editorial promotions on the home page (design 6.1). All static/ISR: data comes from tag-purged caches, nothing reads cookies.
 * These are house content chosen by staff, never sold, so they are deliberately NOT styled or labelled as "Sponsored" and carry
 * no timers or scarcity copy. Empty result renders nothing (the page is unchanged).
 */

export async function PromoStrip({ locale }: { locale: Locale }) {
  const strip = (await loadPromotions("home_strip", locale)).find((p) => p.kind === "announcement_strip");
  if (!strip) return null;
  const t = await getTranslations({ locale, namespace: "promotions" });
  return (
    <div role="region" aria-label={t("announcementAria")} className="bg-brand-900 text-white">
      <Container className="flex min-h-11 flex-wrap items-center justify-center gap-x-3 gap-y-1 py-2 text-sm">
        <p className="font-medium">{strip.headline}{strip.subline ? <span className="text-brand-100"> · {strip.subline}</span> : null}</p>
        {strip.cta ? (
          <Link href={strip.cta.href} className="inline-flex min-h-6 items-center gap-1 font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-white">
            {strip.cta.label} <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </Container>
    </div>
  );
}

function HeroBanner({ p, label }: { p: PublicPromotion; label: string }) {
  return (
    <section aria-label={label} className="overflow-hidden rounded-card border border-line bg-gradient-to-br from-brand-50 to-white">
      <div className={`grid items-center ${p.image ? "md:grid-cols-2" : ""}`}>
        <div className="p-6 sm:p-8">
          <h2 className="text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-3xl">{p.headline}</h2>
          {p.subline ? <p className="mt-2 max-w-prose text-base text-muted">{p.subline}</p> : null}
          {p.cta ? (
            <Link href={p.cta.href} className={`${buttonClasses("primary", "lg")} mt-5`}>
              {p.cta.label} <ArrowRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </div>
        {p.image ? (
          <div className="relative aspect-[16/9] w-full md:aspect-auto md:min-h-64 md:self-stretch">
            <BlurImage src={p.image.src} alt={p.image.alt} sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Top hero banner promotion (one), below the primary hero so the H1 and search stay first. */
export async function PromoHeroBanner({ locale }: { locale: Locale }) {
  const banner = (await loadPromotions("home_hero", locale)).find((p) => p.kind === "hero_banner");
  if (!banner) return null;
  const t = await getTranslations({ locale, namespace: "promotions" });
  return <HeroBanner p={banner} label={t("featuredAria")} />;
}

async function CollectionRail({ p, locale }: { p: PublicPromotion; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "promotions" });
  const ids = p.listingIds.slice(0, 8);
  const listings = (await Promise.all(ids.map((id) => loadListing(id)))).flatMap((l) => (l ? [l] : []));
  if (listings.length === 0) return null;
  const sellers = await Promise.all(listings.map((l) => loadSeller(l.sellerBusinessId)));
  const offers = await Promise.all(listings.map((l) => loadOffer(l.id)));
  return (
    <section aria-labelledby={`promo-${p.id}`}>
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id={`promo-${p.id}`} className="text-xl font-bold tracking-tight text-ink sm:text-[22px]">{p.headline}</h2>
          <p className="text-sm text-muted">{p.subline ?? t("collectionNote")}</p>
        </div>
        {p.cta ? (
          <Link href={p.cta.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
            {p.cta.label} <ArrowRight className="size-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      <Grid>
        {listings.map((l, i) => (
          <ListingCard key={l.id} listing={l} seller={sellers[i]} offer={offers[i]} locale={locale} />
        ))}
      </Grid>
    </section>
  );
}

/** Curated collection rails (admin-picked listings that still pass eligibility at render time). */
export async function PromoCollections({ locale }: { locale: Locale }) {
  const collections = (await loadPromotions("home_panel", locale)).filter((p) => p.kind === "collection").slice(0, 2);
  if (collections.length === 0) return null;
  return (
    <>
      {collections.map((p) => (
        <CollectionRail key={p.id} p={p} locale={locale} />
      ))}
    </>
  );
}
