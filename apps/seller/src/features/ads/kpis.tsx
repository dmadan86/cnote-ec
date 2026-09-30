import { Stat } from "@cnote/ui";
import type { CampaignReport } from "@cnote/ads";
import { inr, pct } from "./format";

/**
 * Honest reporting (design 5.7): cost per enquiry comes first, and a click count is never shown without its invalid share.
 * Impressions and clicks are not real time (impressions roll up hourly, clicks are re-scored for 72 hours), and we say so.
 */
export function Kpis({ r }: { r: CampaignReport }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cost per enquiry" value={r.costPerEnquiryPaise === null ? "-" : inr(r.costPerEnquiryPaise)} hint={`${r.attributedEnquiries} enquiries after an ad click, within 7 days`} />
        <Stat label="Spend" value={inr(r.spendPaise)} hint={r.refundedPaise ? `${inr(r.refundedPaise)} refunded for invalid clicks` : "Only valid clicks are charged"} />
        <Stat label="Valid clicks" value={r.clicks.valid.toLocaleString("en-IN")} hint={`${pct(r.clicks.invalidSharePct)} of ${r.clicks.total} clicks were invalid (not charged)`} />
        <Stat label="Average price per click" value={inr(r.avgCpcPaise)} hint={`${r.impressions.toLocaleString("en-IN")} impressions, ${pct(r.ctrPct)} click rate`} />
      </div>
      <p className="text-xs text-muted">Reporting is not real time. Impressions update hourly and clicks are re-checked for up to 72 hours, so recent numbers can still change.</p>
    </div>
  );
}
