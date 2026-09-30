import { isAdsEnabled } from "@cnote/ads";
import { getLocale, getTranslations } from "next-intl/server";
import { isLocale, localizePath, type Locale } from "@/i18n/config";
import { SponsoredSimilarClient } from "./similar-client";

/**
 * "Sponsored similar" rail for the product page (max 2 cards, separate from the organic "Similar products" rail, never on the
 * seller's own listing). Mount as `<SponsoredSimilar listingId={listing.id} />` (locale is optional) anywhere on the product page.
 * It reads no cookies or headers, so the page stays ISR-cacheable; the cards load client-side from /api/ads/similar.
 */
export async function SponsoredSimilar({ listingId, locale: given }: { listingId: string; locale?: Locale }) {
  if (!isAdsEnabled()) return null;
  const current = given ?? (await getLocale());
  const locale: Locale = isLocale(current) ? current : "en";
  const [t, tc] = await Promise.all([getTranslations({ locale, namespace: "ads" }), getTranslations({ locale, namespace: "cards" })]);
  return (
    <SponsoredSimilarClient
      listingId={listingId}
      locale={locale}
      labels={{
        sponsored: t("sponsored"),
        sponsoredSr: t("sponsoredSr"),
        heading: t("similarHeading"),
        aria: t("similarAria"),
        note: t("similarNote"),
        how: t("howLink"),
        howHref: localizePath("/ranking-and-ads", locale),
        priceOnRequest: tc("priceOnRequest"),
        minOrder: tc.raw("minOrder") as string,
      }}
    />
  );
}
