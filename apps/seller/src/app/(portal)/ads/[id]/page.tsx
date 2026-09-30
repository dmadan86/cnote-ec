import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import { getAdsConfig, getCampaign, getCampaignReport, isAdsEnabled } from "@cnote/ads";
import { getLocale, getTranslations } from "next-intl/server";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { BudgetForm, CampaignControls, KeywordForm, RemoveKeyword } from "@/features/ads/forms";
import { inr, labelOf, pct, STATUS_TONE } from "@/features/ads/format";
import { Kpis } from "@/features/ads/kpis";
import { intlTag } from "@/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ads.meta");
  return { title: t("campaignTitle") };
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/ads/${id}`);
  const t = await getTranslations("ads");
  const l = await getLocale();
  const df = new Intl.DateTimeFormat(intlTag(l), { dateStyle: "medium", timeZone: "Asia/Kolkata" });
  const formatDate = (iso: string) => df.format(new Date(iso));
  if (!isAdsEnabled()) return <EmptyState title={t("comingSoon.title")} description={t("comingSoon.description")} action={<Link href="/ads" className="underline">{t("comingSoon.back")}</Link>} />;
  const camp = await load(() => getCampaign(session.business.id, id));
  if (!camp.ok) notFound();
  const c = camp.data;
  const [report, cfg] = await Promise.all([load(() => getCampaignReport(session.business.id, id, 30)), load(() => getAdsConfig())]);
  const s = { label: labelOf(t, "status", c.status), tone: STATUS_TONE[c.status] ?? ("neutral" as const) };
  const halt = c.haltReason && t.has(`halt.${c.haltReason}`) ? t(`halt.${c.haltReason}`) : null;
  const reviewText = (k: string) => labelOf(t, "review", k);
  const inv = (n: number) => inr(n, l);
  return (
    <div className="space-y-8">
      <PageHeader title={c.name} description={c.endsAt ? t("detail.runsTo", { start: formatDate(c.startsAt.toISOString()), end: formatDate(c.endsAt.toISOString()) }) : t("detail.runs", { start: formatDate(c.startsAt.toISOString()) })} actions={<Link href="/ads" className="text-sm underline">{t("detail.allCampaigns")}</Link>} />
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="text-sm text-muted">{c.totalBudgetPaise ? t("detail.dailyBudgetTotal", { amount: inv(Number(c.dailyBudgetPaise)), total: inv(Number(c.totalBudgetPaise)) }) : t("detail.dailyBudget", { amount: inv(Number(c.dailyBudgetPaise)) })}</span>
      </div>
      {c.status === "rejected" ? <Alert tone="danger">{t("detail.rejected", { reason: c.rejectionReason ?? t("detail.rejectedNoReason") })}</Alert> : null}
      {c.status === "suspended" ? <Alert tone="danger">{t("halt.suspended")} {c.rejectionReason ? t("detail.suspendedReason", { reason: c.rejectionReason }) : ""} {t("detail.suspendedContact")}</Alert> : null}
      {c.status === "pending_review" ? <Alert tone="info">{t("detail.pendingReview")}</Alert> : null}
      {halt && c.status !== "suspended" ? <Alert tone="warning">{t("detail.notRunning", { reason: halt })}</Alert> : null}

      <CampaignControls id={id} status={c.status} />

      <section aria-labelledby="report" className="space-y-3">
        <h2 id="report" className="text-lg font-bold text-ink">{t("detail.results")}</h2>
        {!report.ok ? <Alert tone="danger">{report.error}</Alert> : (
          <>
            <Kpis r={report.data} />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card><CardBody className="space-y-2 text-sm">
                <h3 className="font-semibold text-ink">{t("detail.whyNotShown")}</h3>
                <p className="text-muted">{t.rich("detail.lostShare", { b: (chunks) => <strong className="text-ink">{chunks}</strong>, budget: pct(report.data.lostImpressionShare.budgetPct, l), quality: pct(report.data.lostImpressionShare.qualityPct, l) })}</p>
              </CardBody></Card>
              <Card><CardBody className="space-y-2 text-sm">
                <h3 className="font-semibold text-ink">{t("detail.notCharged")}</h3>
                {Object.keys(report.data.clicks.invalidByReason).length === 0 ? <p className="text-muted">{t("detail.none")}</p> : (
                  <ul className="space-y-1">{Object.entries(report.data.clicks.invalidByReason).map(([k, n]) => <li key={k} className="flex justify-between"><span className="text-muted">{labelOf(t, "invalidReason", k)}</span><span className="font-medium text-ink">{n}</span></li>)}</ul>
                )}
                {report.data.clicks.self ? <p className="text-xs text-muted">{t("detail.selfClicks", { count: report.data.clicks.self })}</p> : null}
              </CardBody></Card>
            </div>
            {report.data.daily.length ? (
              <div className="overflow-x-auto rounded-card border border-line bg-surface">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">{t("detail.dailyCaption")}</caption>
                  <thead className="bg-canvas text-xs uppercase text-muted"><tr><th scope="col" className="p-3">{t("detail.colDate")}</th><th scope="col" className="p-3 text-right">{t("detail.colImpressions")}</th><th scope="col" className="p-3 text-right">{t("detail.colValidClicks")}</th><th scope="col" className="p-3 text-right">{t("detail.colSpend")}</th></tr></thead>
                  <tbody>{report.data.daily.map((d) => <tr key={d.date} className="border-t border-line"><td className="p-3 text-ink">{d.date}</td><td className="p-3 text-right">{d.impressions}</td><td className="p-3 text-right">{d.validClicks}</td><td className="p-3 text-right font-medium text-ink">{inv(d.spendPaise)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="budget" className="space-y-3">
        <h2 id="budget" className="text-lg font-bold text-ink">{t("detail.budget")}</h2>
        {!["ended", "suspended"].includes(c.status) ? <BudgetForm id={id} currentRupees={Number(c.dailyBudgetPaise) / 100} minRupees={cfg.ok ? cfg.data.minDailyBudgetPaise / 100 : 100} /> : <p className="text-sm text-muted">{t("detail.noEdit")}</p>}
      </section>

      {c.adGroups.map((g) => (
        <section key={g.id} aria-labelledby={`g-${g.id}`} className="space-y-4">
          <h2 id={`g-${g.id}`} className="text-lg font-bold text-ink">{g.name}</h2>
          <p className="text-sm text-muted">{t("detail.shownOn", { surfaces: g.surfaces.map((x) => labelOf(t, "surface", x)).join(", ") })} {g.states.length ? t("detail.states", { states: g.states.join(", ") }) : t("detail.allIndia")}{g.pincodePrefixes.length ? ` ${t("detail.pincodes", { pincodes: g.pincodePrefixes.join(", ") })}` : ""} {t("detail.reviewLine", { status: reviewText(g.status) })}</p>
          <div>
            <h3 className="text-sm font-semibold text-ink">{t("detail.products")}</h3>
            <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
              {g.listings.map((l) => (
                <li key={l.id} className="space-y-1 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted">{l.listingId.slice(0, 8)}</span><Badge tone={l.reviewStatus === "approved" ? "success" : l.reviewStatus === "rejected" ? "danger" : "brand"}>{reviewText(l.reviewStatus)}</Badge></div>
                  {l.reviewNote ? <p className="text-xs text-muted">{t("detail.reviewerNote", { note: l.reviewNote.replace(/_/g, " ") })}</p> : null}
                  {l.reviewStatus === "approved" && !l.eligible && l.ineligibleReason ? <p className="text-xs text-red-800">{t("detail.notRunningItem", { reason: labelOf(t, "ineligible", l.ineligibleReason) })}</p> : null}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">{t("detail.keywords")}</h3>
            {g.keywords.length === 0 ? <p className="mt-1 text-sm text-muted">{t("detail.noKeywords")}</p> : (
              <ul className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
                {g.keywords.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                    <span className="text-ink">{k.negative ? "- " : ""}{k.text} <span className="text-xs text-muted">[{k.matchType}]</span> <Badge tone={k.reviewStatus === "approved" ? "success" : k.reviewStatus === "rejected" ? "danger" : "brand"}>{reviewText(k.reviewStatus)}</Badge>{k.reviewNote ? <span className="ml-2 text-xs text-muted">{k.reviewNote.replace(/_/g, " ")}</span> : null}</span>
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
