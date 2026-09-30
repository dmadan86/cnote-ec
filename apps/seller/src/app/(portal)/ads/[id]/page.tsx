import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import { getAdsConfig, getCampaign, getCampaignReport, isAdsEnabled } from "@cnote/ads";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { BudgetForm, CampaignControls, KeywordForm, RemoveKeyword } from "@/features/ads/forms";
import { HALT_TEXT, INELIGIBLE_TEXT, inr, pct, REVIEW_TEXT, STATUS_LABEL, SURFACE_LABEL } from "@/features/ads/format";
import { Kpis } from "@/features/ads/kpis";

export const metadata: Metadata = { title: "Ad campaign" };

const REASON_LABEL: Record<string, string> = { bot_ua: "Automated traffic", duplicate: "Repeat click", over_budget: "Over budget (not charged)", wallet_empty: "Wallet empty (not charged)", ip_cluster: "Many clicks from one network", repeat_visitor: "Same visitor clicking repeatedly", ip_burst: "Sudden spike", campaign_inactive: "Campaign not running", staff_review: "Removed by our review" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/ads/${id}`);
  if (!isAdsEnabled()) return <EmptyState title="Coming soon" description="Advertising is not switched on yet." action={<Link href="/ads" className="underline">Back to Ads</Link>} />;
  const camp = await load(() => getCampaign(session.business.id, id));
  if (!camp.ok) notFound();
  const c = camp.data;
  const [report, cfg] = await Promise.all([load(() => getCampaignReport(session.business.id, id, 30)), load(() => getAdsConfig())]);
  const s = STATUS_LABEL[c.status] ?? { label: c.status, tone: "neutral" as const };
  const halt = c.haltReason ? HALT_TEXT[c.haltReason] : null;
  return (
    <div className="space-y-8">
      <PageHeader title={c.name} description={`Runs from ${formatDate(c.startsAt.toISOString())}${c.endsAt ? ` to ${formatDate(c.endsAt.toISOString())}` : " until you pause it"}.`} actions={<Link href="/ads" className="text-sm underline">All campaigns</Link>} />
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="text-sm text-muted">Daily budget {inr(Number(c.dailyBudgetPaise))}{c.totalBudgetPaise ? `, total ${inr(Number(c.totalBudgetPaise))}` : ""}</span>
      </div>
      {c.status === "rejected" ? <Alert tone="danger">Not approved: {c.rejectionReason ?? "see the notes below"}. Fix the items below and send it for review again.</Alert> : null}
      {c.status === "suspended" ? <Alert tone="danger">{HALT_TEXT.suspended} {c.rejectionReason ? `Reason: ${c.rejectionReason}.` : ""} Contact support if you think this is a mistake.</Alert> : null}
      {c.status === "pending_review" ? <Alert tone="info">In review. Our team usually replies within one business day. New keywords and products are reviewed one by one, so one issue does not stop the rest.</Alert> : null}
      {halt && c.status !== "suspended" ? <Alert tone="warning">Not running right now: {halt}</Alert> : null}

      <CampaignControls id={id} status={c.status} />

      <section aria-labelledby="report" className="space-y-3">
        <h2 id="report" className="text-lg font-bold text-ink">Results, last 30 days</h2>
        {!report.ok ? <Alert tone="danger">{report.error}</Alert> : (
          <>
            <Kpis r={report.data} />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card><CardBody className="space-y-2 text-sm">
                <h3 className="font-semibold text-ink">Why you are not shown more</h3>
                <p className="text-muted">Share of chances you missed: <strong className="text-ink">{pct(report.data.lostImpressionShare.budgetPct)}</strong> because the daily budget ran out (raise the budget), <strong className="text-ink">{pct(report.data.lostImpressionShare.qualityPct)}</strong> because other ads matched better or you hit the frequency limit (improve product photos, titles and your trust score).</p>
              </CardBody></Card>
              <Card><CardBody className="space-y-2 text-sm">
                <h3 className="font-semibold text-ink">Clicks that were not charged</h3>
                {Object.keys(report.data.clicks.invalidByReason).length === 0 ? <p className="text-muted">None so far.</p> : (
                  <ul className="space-y-1">{Object.entries(report.data.clicks.invalidByReason).map(([k, n]) => <li key={k} className="flex justify-between"><span className="text-muted">{REASON_LABEL[k] ?? k}</span><span className="font-medium text-ink">{n}</span></li>)}</ul>
                )}
                {report.data.clicks.self ? <p className="text-xs text-muted">{report.data.clicks.self} clicks came from your own team. They are never charged; please do not click your own ads.</p> : null}
              </CardBody></Card>
            </div>
            {report.data.daily.length ? (
              <div className="overflow-x-auto rounded-card border border-line bg-surface">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Daily results</caption>
                  <thead className="bg-canvas text-xs uppercase text-muted"><tr><th scope="col" className="p-3">Date</th><th scope="col" className="p-3 text-right">Impressions</th><th scope="col" className="p-3 text-right">Valid clicks</th><th scope="col" className="p-3 text-right">Spend</th></tr></thead>
                  <tbody>{report.data.daily.map((d) => <tr key={d.date} className="border-t border-line"><td className="p-3 text-ink">{d.date}</td><td className="p-3 text-right">{d.impressions}</td><td className="p-3 text-right">{d.validClicks}</td><td className="p-3 text-right font-medium text-ink">{inr(d.spendPaise)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="budget" className="space-y-3">
        <h2 id="budget" className="text-lg font-bold text-ink">Budget</h2>
        {!["ended", "suspended"].includes(c.status) ? <BudgetForm id={id} currentRupees={Number(c.dailyBudgetPaise) / 100} minRupees={cfg.ok ? cfg.data.minDailyBudgetPaise / 100 : 100} /> : <p className="text-sm text-muted">This campaign can no longer be edited.</p>}
      </section>

      {c.adGroups.map((g) => (
        <section key={g.id} aria-labelledby={`g-${g.id}`} className="space-y-4">
          <h2 id={`g-${g.id}`} className="text-lg font-bold text-ink">{g.name}</h2>
          <p className="text-sm text-muted">Shown on: {g.surfaces.map((x) => SURFACE_LABEL[x] ?? x).join(", ")}.{g.states.length ? ` States: ${g.states.join(", ")}.` : " All of India."}{g.pincodePrefixes.length ? ` Pincodes: ${g.pincodePrefixes.join(", ")}.` : ""} Review: {REVIEW_TEXT[g.status]}.</p>
          <div>
            <h3 className="text-sm font-semibold text-ink">Products</h3>
            <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
              {g.listings.map((l) => (
                <li key={l.id} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted">{l.listingId.slice(0, 8)}</span><Badge tone={l.reviewStatus === "approved" ? "success" : l.reviewStatus === "rejected" ? "danger" : "brand"}>{REVIEW_TEXT[l.reviewStatus]}</Badge></div>
                  {l.reviewNote ? <p className="text-xs text-muted">Reviewer note: {l.reviewNote.replace(/_/g, " ")}</p> : null}
                  {l.reviewStatus === "approved" && !l.eligible && l.ineligibleReason ? <p className="text-xs text-red-800">Not running: {INELIGIBLE_TEXT[l.ineligibleReason] ?? l.ineligibleReason}</p> : null}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Keywords</h3>
            {g.keywords.length === 0 ? <p className="mt-1 text-sm text-muted">No keywords.</p> : (
              <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
                {g.keywords.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                    <span className="text-ink">{k.negative ? "- " : ""}{k.text} <span className="text-xs text-muted">[{k.matchType}]</span> <Badge tone={k.reviewStatus === "approved" ? "success" : k.reviewStatus === "rejected" ? "danger" : "brand"}>{REVIEW_TEXT[k.reviewStatus]}</Badge>{k.reviewNote ? <span className="ml-2 text-xs text-muted">{k.reviewNote.replace(/_/g, " ")}</span> : null}</span>
                    {!["ended", "suspended"].includes(c.status) ? <RemoveKeyword id={id} keywordId={k.id} text={k.text} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!["ended", "suspended"].includes(c.status) ? <KeywordForm id={id} /> : null}
        </section>
      ))}
    </div>
  );
}
