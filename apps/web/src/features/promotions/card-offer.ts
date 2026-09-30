import { getTranslations } from "next-intl/server";
import type { PublicOffer } from "@cnote/promotions";
import type { Locale } from "@/i18n/config";

/**
 * Card-level view of an offer: one text chip (timed > volume > free delivery). For a timed price the card shows the OFFER price
 * and, only when the platform derived a 30-day reference above it, that reference struck through. Otherwise the price is untouched.
 */
export async function cardOffer(offer: PublicOffer, locale: Locale): Promise<{ pricePaise: number | null; chip: { label: string; referencePaise: number | null; referenceLabel: string; percentLabel: string | null } } | null> {
  const t = await getTranslations({ locale, namespace: "promotions" });
  if (offer.timed) {
    const r = offer.timed.reference;
    return { pricePaise: offer.timed.unitPricePaise, chip: { label: t("offerChip"), referencePaise: r?.pricePaise ?? null, referenceLabel: t("referenceSr"), percentLabel: r ? t("percentBelow", { percent: r.percentOff }) : null } };
  }
  if (offer.tiers) return { pricePaise: null, chip: { label: t("offerChipVolume"), referencePaise: null, referenceLabel: t("referenceSr"), percentLabel: null } };
  if (offer.freeDelivery) return { pricePaise: null, chip: { label: t("offerChipDelivery"), referencePaise: null, referenceLabel: t("referenceSr"), percentLabel: null } };
  return null;
}
