import type { TrustLabels } from "@cnote/ui";

type Translate = (key: string) => string;

/** TrustBadge labels from the `cards` catalogue (`t` = useTranslations("cards") / getTranslations({ namespace: "cards" })). */
export function trustLabels(t: Translate): TrustLabels {
  return { unverified: t("unverified"), unverifiedTitle: t("unverifiedTitle"), tiers: [t("tier0"), t("tier1"), t("tier2"), t("tier3")] };
}
