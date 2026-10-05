import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@cnote/ui";
import type { Availability, ListingView } from "@cnote/catalogue";
import { intlTag } from "@/i18n/config";

const TONE = { in_stock: "success", made_to_order: "warning", out_of_stock: "danger" } as const;

/** Stock state as text + tone (never colour alone), with quantity / lead time / last update when known. */
export function AvailabilityBadge({
  availability,
  availableQty,
  leadTimeDays,
  stockUpdatedAt,
}: {
  availability: Availability;
  availableQty?: number | null;
  leadTimeDays?: number | null;
  stockUpdatedAt?: string | null;
}) {
  const t = useTranslations("stock");
  const locale = useLocale();
  const tag = intlTag(locale);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="availability">
      <Badge tone={TONE[availability]}>{t(`availability.${availability}`)}</Badge>
      {availability === "made_to_order" && leadTimeDays != null ? <span className="text-xs text-muted">{t("badge.leadTime", { days: leadTimeDays })}</span> : null}
      {availability === "in_stock" && availableQty != null ? <span className="text-xs text-muted">{t("badge.qty", { qty: new Intl.NumberFormat(tag).format(availableQty) })}</span> : null}
      {stockUpdatedAt ? (
        <span className="text-xs text-muted">{t("badge.updated", { when: new Date(stockUpdatedAt).toLocaleDateString(tag, { dateStyle: "medium", timeZone: "Asia/Kolkata" }) })}</span>
      ) : null}
    </div>
  );
}

/** Listing-level badge: shows "N variants" and the best-of-variants state when the listing has variants. */
export function ListingStockBadges({ listing }: { listing: ListingView }) {
  const t = useTranslations("stock");
  const variants = listing.variants ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <AvailabilityBadge
        availability={listing.availability ?? "in_stock"}
        availableQty={variants.length ? null : listing.availableQty}
        leadTimeDays={listing.trade?.leadTimeDays ?? null}
        stockUpdatedAt={listing.stockUpdatedAt}
      />
      {variants.length ? <span className="text-xs text-muted" data-testid="variant-count">{t("badge.variants", { count: variants.length })} · {t("badge.rollup")}</span> : null}
    </div>
  );
}
