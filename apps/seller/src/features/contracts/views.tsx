import { getTranslations } from "next-intl/server";
import type { RateContractView, RcRevisionView } from "@cnote/enquiry";
import { type BadgeTone } from "@cnote/ui";

export const RC_TONE: Record<RateContractView["status"], BadgeTone> = { draft: "neutral", proposed: "warning", active: "success", expired: "neutral", terminated: "danger" };

/** A usage bar with the percentage always in text (never colour alone). */
export function Usage({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label} className="h-2 w-24 overflow-hidden rounded-full bg-line">
        <div className={percent >= 100 ? "h-full bg-danger" : percent >= 80 ? "h-full bg-warning" : "h-full bg-brand-600"} style={{ width: `${percent}%` }} />
      </div>
      <span className="text-xs tabular-nums">{percent}%</span>
    </div>
  );
}

export async function TermsTable({ rev, inr }: { rev: RcRevisionView; inr: (paise: number) => string }) {
  const t = await getTranslations("contracts");
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <caption className="sr-only">{t("itemsCaption")}</caption>
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th scope="col" className="py-2 pe-2 text-start font-medium">{t("col.item")}</th>
            <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.price")}</th>
            <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.gst")}</th>
            <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.moq")}</th>
            <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.cap")}</th>
            <th scope="col" className="py-2 text-start font-medium">{t("col.used")}</th>
          </tr>
        </thead>
        <tbody>
          {rev.items.map((i) => (
            <tr key={i.itemKey} className="border-b border-line align-top">
              <th scope="row" className="py-2 pe-2 text-start font-normal">
                {i.description}
                <span className="block text-xs text-muted">
                  {i.variationKind === "indexed" ? t("indexedNote", { percent: (i.variationCapBps ?? 0) / 100, note: i.variationNote ?? "" }) : t("fixedNote")}
                </span>
              </th>
              <td className="py-2 pe-2 text-end tabular-nums">{inr(i.unitPricePaise)} / {i.unit}</td>
              <td className="py-2 pe-2 text-end tabular-nums">{i.gstRateBps / 100}%</td>
              <td className="py-2 pe-2 text-end tabular-nums">{i.moq ?? "-"}</td>
              <td className="py-2 pe-2 text-end tabular-nums">{i.quantityCap ?? t("noCap")}</td>
              <td className="py-2">
                {i.quantityCap === null ? (
                  <span className="text-xs">{t("usedQty", { qty: i.consumedQuantity, unit: i.unit })}</span>
                ) : (
                  <div className="space-y-1">
                    <Usage percent={i.usedPercent ?? 0} label={t("usedLabel", { item: i.description })} />
                    <span className="text-xs text-muted">{t("usedOf", { used: i.consumedQuantity, cap: i.quantityCap })}</span>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
