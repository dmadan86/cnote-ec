"use client";
// Availability of what the buyer is looking at: the chosen variant, else the listing (the best of its variants). Shows the badge,
// the quantity on hand, the lead time of a made-to-order item, when the seller last updated the stock, and what out of stock means.
import { useFormatter, useTranslations } from "next-intl";
import { AvailabilityBadge } from "./availability-badge";
import { useVariantSelection } from "./variant-context";
import type { Availability } from "./variants";

/** Plain-text availability, used by the badge, the option tags and the live announcement. */
export function availabilityText(t: (key: string, values?: Record<string, string | number>) => string, a: Availability, leadTimeDays?: number | null): string {
  if (a === "made_to_order" && leadTimeDays != null) return t("availability.madeToOrderLead", { days: leadTimeDays });
  return t(`availability.${a}`);
}

export function StockStatus({ listingLeadTimeDays }: { listingLeadTimeDays: number | null }) {
  const t = useTranslations("pdp");
  const format = useFormatter();
  const { selected, stock } = useVariantSelection();
  const availability = selected?.availability ?? stock.availability;
  const qty = selected ? selected.availableQty : stock.availableQty;
  const lead = selected?.leadTimeDays ?? listingLeadTimeDays;
  const updated = stock.stockUpdatedAt ? format.dateTime(new Date(stock.stockUpdatedAt), { dateStyle: "medium" }) : null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="pdp-stock">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AvailabilityBadge availability={availability} label={availabilityText(t, availability, lead)} />
        {qty != null && qty > 0 && availability === "in_stock" ? <span className="text-sm text-ink">{t("availability.qty", { qty })}</span> : null}
        {updated ? <span className="text-xs text-muted">{t("availability.updated", { date: updated })}</span> : null}
      </div>
      {availability === "out_of_stock" ? <p className="text-sm text-muted">{t("availability.outNote")}</p> : null}
    </div>
  );
}
