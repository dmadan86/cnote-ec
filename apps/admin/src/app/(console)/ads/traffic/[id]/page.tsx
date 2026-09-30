import { getCampaignReport, listClicksForReview } from "@cnote/ads";
import { Alert, PageHeader } from "@cnote/ui";
import { requireStaff } from "@/lib/auth";
import { safe } from "@/lib/util";
import { AdsNav } from "../../ads-nav";
import { InvalidateClicksForm } from "../../forms";

export const metadata = { title: "Review ad clicks" };

export default async function TrafficCampaign({ params }: PageProps<"/ads/traffic/[id]">) {
  const { id } = await params;
  await requireStaff(`/ads/traffic/${id}`, "ads.fraud.review");
  const [clicks, report] = await Promise.all([safe("ads.clicks", () => listClicksForReview(id, 200)), safe("ads.report", () => getCampaignReport(null, id, 7))]);
  return (
    <>
      <PageHeader title="Review clicks" description={`Campaign ${id}. Newest first, last 200 clicks.`} />
      <AdsNav active="/ads/traffic" />
      {report ? <p className="text-sm text-ink">Last 7 days: {report.clicks.total} clicks, {report.clicks.valid} valid, {report.clicks.invalidSharePct}% invalid or self. By reason: {Object.entries(report.clicks.invalidByReason).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.</p> : null}
      {clicks === null ? <Alert tone="warning">Clicks are unavailable.</Alert> : <InvalidateClicksForm campaignId={id} clicks={clicks} />}
    </>
  );
}
