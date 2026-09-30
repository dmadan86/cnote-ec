import { priceIntelEnabled } from "@cnote/prices";
import { getTranslations } from "next-intl/server";
import { BenchmarkHint } from "./benchmark-hint";

/** RFQ-page mount: renders nothing while PRICE_INTEL_ENABLED is off. Templates keep {tokens}; values are filled live. */
export async function PriceHint({ locale = "en" }: { locale?: string }) {
  if (!priceIntelEnabled()) return null;
  const t = await getTranslations({ locale, namespace: "prices" });
  const raw = (k: string) => t.raw(k) as string;
  return (
    <BenchmarkHint
      labels={{
        title: t("title"), sectionLabel: t("sectionLabel"), widerArea: t("widerArea"), checking: t("checking"),
        range: raw("range"), basis: raw("basis"), trendUp: raw("trendUp"), trendDown: raw("trendDown"), trendFlat: t("trendFlat"),
      }}
    />
  );
}
