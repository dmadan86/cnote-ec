import { ProductCard } from "@cnote/ui";
import type { SponsoredSlot } from "@cnote/ads";
import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import type { Locale } from "@/i18n/config";
import { LocaleLink } from "@/i18n/link";
import { moqText } from "@/features/search/format";
import { getUiLabels } from "@/features/search/labels";
import { ProductImage } from "@/features/search/product-image";
import { SponsoredLabel } from "./label";
import { SponsoredLink } from "./sponsored-link";

const CARD_SIZES = "(min-width: 1280px) 12vw, (min-width: 1024px) 20vw, (min-width: 640px) 30vw, 45vw";

export { SponsoredLabel };

export async function getAdLabels(locale: Locale) {
  const t = await getTranslations({ locale, namespace: "ads" });
  return {
    sponsored: t("sponsored"),
    sponsoredSr: t("sponsoredSr"),
    heading: t("blockHeading"),
    aria: t("blockAria"),
    note: t("blockNote"),
    how: t("howLink"),
    why: t("whyLabel"),
    end: t("endOfSponsored"),
  };
}
export type AdLabels = Awaited<ReturnType<typeof getAdLabels>>;

/** Product card for an ad. Only accepts a decision from @cnote/ads (`SponsoredSlot`), so an unlabelled ad cannot be built in typed code. */
export async function SponsoredCard({ slot, locale, priority }: { slot: SponsoredSlot; locale: Locale; priority?: boolean }) {
  const [labels, ad] = await Promise.all([getUiLabels(locale), getAdLabels(locale)]);
  const l = slot.listing;
  const s = slot.seller;
  return (
    <ProductCard
      id={l.id}
      href={`${slot.clickHref}?l=${locale}`}
      title={l.title}
      image={
        <>
          <ProductImage src={l.imageUrls[0]} blur={l.imageBlurs?.[0]} sizes={CARD_SIZES} priority={priority} />
          <SponsoredLabel label={ad.sponsored} srLabel={ad.sponsoredSr} className="absolute left-2 top-2 z-10" />
        </>
      }
      pricePaise={l.pricePaise}
      priceUnit={l.priceUnit}
      moqText={moqText(l)}
      seller={{ name: s.name, city: s.city, tier: s.verificationTier, badgeActive: s.badgeActive }}
      wishlist={<span />}
      linkComponent={SponsoredLink}
      labels={labels.card}
      className="border-dashed border-ink/40"
    />
  );
}

/** The labelled block above organic results: heading, plain-language explanation, link to the ranking page, visible boundary. */
export async function SponsoredBlock({ slots, locale }: { slots: SponsoredSlot[]; locale: Locale }) {
  if (!slots.length) return null;
  const ad = await getAdLabels(locale);
  return (
    <section aria-labelledby="sponsored-heading" className="mb-8 rounded-card border-2 border-dashed border-ink/40 bg-canvas p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="sponsored-heading" className="text-base font-bold text-ink">
          {ad.heading}
        </h2>
        <LocaleLink href="/ranking-and-ads" className="text-sm text-brand-700 underline underline-offset-2">
          {ad.why}
        </LocaleLink>
      </div>
      <p className="mt-1 flex items-start gap-1.5 text-sm text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        {ad.note}
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {slots.map((s, i) => (
          <SponsoredCard key={s.clickToken} slot={s} locale={locale} priority={i < 2} />
        ))}
      </ul>
      <p className="sr-only">{ad.end}</p>
    </section>
  );
}
