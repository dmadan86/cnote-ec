import { Stat } from "@cnote/ui";
import type { CampaignReport } from "@cnote/ads";
import { getLocale, getTranslations } from "next-intl/server";
import { inr, num, pct } from "./format";

/**
 * Honest reporting (design 5.7): cost per enquiry comes first, and a click count is never shown without its invalid share.
 * Impressions and clicks are not real time (impressions roll up hourly, clicks are re-scored for 72 hours), and we say so.
 */
export async function Kpis({ r }: { r: CampaignReport }) {
  const t = await getTranslations("ads.kpi");
  const l = await getLocale();
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("costPerEnquiry")} value={r.costPerEnquiryPaise === null ? "-" : inr(r.costPerEnquiryPaise, l)} hint={t("costPerEnquiryHint", { count: r.attributedEnquiries })} />
        <Stat label={t("spend")} value={inr(r.spendPaise, l)} hint={r.refundedPaise ? t("refunded", { amount: inr(r.refundedPaise, l) }) : t("onlyValid")} />
        <Stat label={t("validClicks")} value={num(r.clicks.valid, l)} hint={t("validHint", { pct: pct(r.clicks.invalidSharePct, l), total: r.clicks.total })} />
        <Stat label={t("avgCpc")} value={inr(r.avgCpcPaise, l)} hint={t("avgHint", { impressions: num(r.impressions, l), ctr: pct(r.ctrPct, l) })} />
      </div>
      <p className="text-xs text-muted">{t("note")}</p>
    </div>
  );
}
