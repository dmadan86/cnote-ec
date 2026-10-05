import type { RateContractView, RcItemView, RcRevisionView, RcStatus } from "@cnote/enquiry";
import { Badge, type BadgeTone } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";

export { day, inr } from "@/features/purchase-orders/po-view";
import { day, inr } from "@/features/purchase-orders/po-view";

export const STATUS_TONE: Record<RcStatus, BadgeTone> = { draft: "neutral", proposed: "warning", active: "success", expired: "neutral", terminated: "danger" };

export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

/** Status is always words: never colour alone. */
export async function StatusBadge({ status, locale }: { status: RcStatus; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "contracts.status" });
  return <Badge tone={STATUS_TONE[status]}>{t(status)}</Badge>;
}

/** A used/limit bar with the numbers as text; the bar itself is decoration for sighted users, the progressbar role carries the value. */
export function UsageBar({ label, percent, text }: { label: string; percent: number | null; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-muted">{text}</span>
      </div>
      {percent !== null ? (
        <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}%`} className="h-2 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full bg-brand-600" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** The items of one revision as a table, with consumption when the revision is the one in force. */
export async function TermsTable({ rev, locale, showUsage }: { rev: RcRevisionView; locale: Locale; showUsage: boolean }) {
  const t = await getTranslations({ locale, namespace: "contracts" });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t("terms.caption", { revision: rev.revision })}</caption>
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">{t("col.item")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("col.price")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("col.gst")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t("col.moq")}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{showUsage ? t("col.used") : t("col.cap")}</th>
            <th scope="col" className="py-2 font-medium">{t("col.variation")}</th>
          </tr>
        </thead>
        <tbody>
          {rev.items.map((i) => (
            <tr key={i.itemKey} className="border-b border-line align-top">
              <th scope="row" className="py-2 pr-3 font-medium text-ink">{i.description}{i.hsn ? <span className="block text-xs font-normal text-muted">{t("col.hsnValue", { hsn: i.hsn })}</span> : null}</th>
              <td className="py-2 pr-3">{t("priceValue", { price: inr(i.unitPricePaise), unit: i.unit })}</td>
              <td className="py-2 pr-3">{i.gstRateBps / 100}%</td>
              <td className="py-2 pr-3">{i.moq ? `${i.moq} ${i.unit}` : t("none")}</td>
              <td className="py-2 pr-3">{usageText(i, showUsage, t)}</td>
              <td className="py-2">{i.variationKind === "indexed" ? t("variation.indexedValue", { cap: (i.variationCapBps ?? 0) / 100, note: i.variationNote ?? "" }) : t("variation.fixed")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function usageText(i: RcItemView, showUsage: boolean, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (!showUsage) return i.quantityCap ? `${i.quantityCap} ${i.unit}` : t("none");
  if (i.quantityCap === null) return t("usage.uncapped", { used: i.consumedQuantity, unit: i.unit });
  return t("usage.of", { used: i.consumedQuantity, cap: i.quantityCap, unit: i.unit, percent: i.usedPercent ?? 0 });
}

export function TermsSummary({ rev, locale, t }: { rev: RcRevisionView; locale: Locale; t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <Row k={t("summary.period")} v={t("summary.periodValue", { from: day(rev.validFrom, locale), to: day(rev.validTo, locale) })} />
      <Row k={t("summary.terms")} v={t("summary.termsValue", { days: rev.paymentTermsDays })} />
      <Row k={t("summary.basis")} v={t(`basis.${rev.priceBasis}`)} />
      <Row k={t("summary.valueCap")} v={rev.valueCapPaise === null ? t("none") : inr(rev.valueCapPaise)} />
      {rev.notes ? <Row k={t("summary.notes")} v={<span className="whitespace-pre-line">{rev.notes}</span>} /> : null}
      {rev.changeNote ? <Row k={t("summary.changeNote")} v={rev.changeNote} /> : null}
    </dl>
  );
}

export type ContractT = Awaited<ReturnType<typeof getTranslations>>;
export type { RateContractView };
