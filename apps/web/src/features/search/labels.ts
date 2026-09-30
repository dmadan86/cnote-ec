import type { TrustLabels } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";

/** Translated strings for the @cnote/ui card/badge/pagination/breadcrumb components (server side). */
export async function getUiLabels(locale: Locale) {
  const t = await getTranslations({ locale, namespace: "cards" });
  const trust: TrustLabels = { unverified: t("unverified"), unverifiedTitle: t("unverifiedTitle"), tiers: [t("tier0"), t("tier1"), t("tier2"), t("tier3")] };
  return {
    trust,
    tierName: (tier: number) => trust.tiers[Math.min(Math.max(tier, 0), 3)]!,
    card: { priceOnRequest: t("priceOnRequest"), minOrder: t.raw("minOrder") as string, trust },
    seller: { trustScore: t.raw("trustScore") as string, trust },
    pagination: { nav: t("pagination"), previous: t("previous"), next: t("next"), page: t.raw("page") as string },
    breadcrumb: t("breadcrumb"),
    home: t("home"),
  };
}
