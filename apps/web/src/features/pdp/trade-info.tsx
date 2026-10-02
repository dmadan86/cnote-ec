import { getTranslations } from "next-intl/server";
import type { ListingView } from "@cnote/catalogue";
import { moqText } from "@/features/search/format";
import { formatPaise } from "./tiers";

const grouped = new Intl.NumberFormat("en-IN");

/** Rows for the trade block: only facts the listing actually has (no placeholders). Pure, so it is unit-tested. */
export function tradeRows(l: Pick<ListingView, "priceUnit" | "moq" | "moqUnit" | "hsn" | "trade">): { key: string; value: string | string[] }[] {
  const tr = l.trade ?? {};
  const rows: { key: string; value: string | string[] }[] = [];
  const moq = moqText(l);
  if (l.priceUnit) rows.push({ key: "unitSold", value: l.priceUnit });
  if (moq) rows.push({ key: "moq", value: moq });
  if (l.hsn) rows.push({ key: "hsn", value: l.hsn });
  if (tr.leadTimeDays != null) rows.push({ key: "leadTime", value: String(tr.leadTimeDays) });
  if (tr.packaging) rows.push({ key: "packaging", value: tr.packaging });
  if (tr.sampleAvailable) rows.push({ key: "sample", value: tr.samplePricePaise == null ? "free-unspecified" : tr.samplePricePaise === 0 ? "free" : String(tr.samplePricePaise) });
  if (tr.supplyCapacityPerMonth != null) rows.push({ key: "capacity", value: String(tr.supplyCapacityPerMonth) });
  if (tr.paymentTerms) rows.push({ key: "paymentTerms", value: tr.paymentTerms });
  if (tr.certifications?.length) rows.push({ key: "certifications", value: tr.certifications });
  return rows;
}

/**
 * Trade information from the listing (unit, MOQ, HSN) plus the optional seller-provided fields (lead time, packaging, sample,
 * supply capacity, payment terms, certifications). GST rate is intentionally absent: there is no HSN-to-rate config in the
 * catalogue, and an invented rate on a trade page would be worse than none.
 */
export async function TradeInfo({ listing, locale }: { listing: ListingView; locale: string }) {
  const t = await getTranslations({ locale, namespace: "pdp" });
  const rows = tradeRows(listing);
  if (!rows.length) return null;
  const unit = listing.priceUnit ?? "";
  const label = (r: { key: string; value: string | string[] }): React.ReactNode => {
    switch (r.key) {
      case "leadTime":
        return t("leadTimeValue", { days: Number(r.value) });
      case "sample":
        return r.value === "free-unspecified" ? t("sampleAvailable") : r.value === "free" ? t("sampleFree") : t("sampleAvailablePaid", { price: formatPaise(Number(r.value)) });
      case "capacity":
        return t("capacityValue", { qty: grouped.format(Number(r.value)), unit });
      case "certifications":
        return (
          <ul className="flex flex-wrap gap-1.5">
            {(r.value as string[]).map((c) => (
              <li key={c} className="rounded-full border border-line bg-canvas px-2.5 py-0.5 text-xs font-medium text-ink">
                {c}
              </li>
            ))}
          </ul>
        );
      default:
        return r.value as string;
    }
  };
  return (
    <section aria-labelledby="trade-info" data-testid="pdp-trade">
      <h2 id="trade-info" className="text-base font-bold text-ink">
        {t("tradeInfo")}
      </h2>
      <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t("tradeCaption", { title: listing.title })}</caption>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="w-40 px-4 py-2.5 text-left align-top font-normal text-muted">
                  {t(r.key)}
                </th>
                <td className="px-4 py-2.5 font-medium text-ink">{label(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
