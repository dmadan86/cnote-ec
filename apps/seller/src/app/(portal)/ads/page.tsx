import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, buttonClasses, Card, CardBody, EmptyState, Money, PageHeader, Stat } from "@cnote/ui";
import { getAdvertiserOverview, getAdsConfig, getPublicRateCard, isAdsEnabled } from "@cnote/ads";
import { getAdWalletBalance, getAdWalletLedger } from "@cnote/billing";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { HALT_TEXT, inr, pct, STATUS_LABEL, SURFACE_LABEL } from "@/features/ads/format";

export const metadata: Metadata = { title: "Ads" };

const REASON: Record<string, string> = {
  topup: "Money added", spend: "Ad spend", refund_invalid_click: "Refund: invalid click", promo_credit: "Promo credit", promo_expire: "Promo credit expired", refund_to_source: "Refunded to you", adjustment: "Adjustment",
};

export default async function AdsPage() {
  const session = await requireSeller("/ads");
  if (!isAdsEnabled()) {
    return (
      <div className="space-y-6">
        <PageHeader title="Ads" description="Sponsored products: reach more buyers, pay only for real clicks." />
        <EmptyState
          title="Coming soon"
          description="Advertising is not switched on yet. When it is, you will pay a fixed, public price per click, your ads will always be labelled Sponsored, and paying will never change your verification badge or normal search position."
        />
      </div>
    );
  }
  const id = session.business.id;
  const [overview, balance, ledger, rates, cfg] = await Promise.all([
    load(() => getAdvertiserOverview(id, 30)),
    load(() => getAdWalletBalance(id)),
    load(() => getAdWalletLedger(id, 10)),
    load(() => getPublicRateCard()),
    load(() => getAdsConfig()),
  ]);
  const total = overview.ok ? overview.data.reduce((s, c) => s + c.report.spendPaise, 0) : 0;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Ads"
        description="Sponsored products. A fixed public price per click, you set a daily budget, and you never pay for invalid clicks."
        actions={<Link href="/ads/new" className={buttonClasses("primary")}>Create campaign</Link>}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Ad wallet" value={balance.ok ? <Money paise={balance.data} className="text-2xl" /> : "-"} hint="Separate from your lead credits. Ads pause when it is empty." />
        <Stat label="Spend, last 30 days" value={inr(total)} hint="Valid clicks only" />
        <Stat label="Campaigns" value={overview.ok ? overview.data.length : "-"} />
      </div>
      {!balance.ok ? <Alert tone="danger">{balance.error}</Alert> : null}
      {balance.ok && balance.data <= 0 ? (
        <Alert tone="warning">Your ad wallet is empty, so your campaigns are not running. During the pilot, our finance team adds funds after a bank transfer: contact support with your business name. Online top-up is coming.</Alert>
      ) : null}

      <section aria-labelledby="campaigns" className="space-y-3">
        <h2 id="campaigns" className="text-lg font-bold text-ink">Your campaigns</h2>
        {!overview.ok ? <Alert tone="danger">{overview.error}</Alert> : overview.data.length === 0 ? (
          <EmptyState title="No campaigns yet" description="Create your first campaign in a few minutes. Start with a small daily budget; you can pause any time." action={<Link href="/ads/new" className={buttonClasses("primary")}>Create campaign</Link>} />
        ) : (
          <ul className="space-y-3">
            {overview.data.map((c) => {
              const s = STATUS_LABEL[c.status] ?? { label: c.status, tone: "neutral" as const };
              return (
                <li key={c.id}>
                  <Card>
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <Link href={`/ads/${c.id}`} className="font-semibold text-ink underline-offset-2 hover:underline">{c.name}</Link>
                        <div className="flex flex-wrap items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge></div>
                      </div>
                      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                        <div><dt className="text-xs text-muted">Spend (30 days)</dt><dd className="font-semibold text-ink">{inr(c.report.spendPaise)}</dd></div>
                        <div><dt className="text-xs text-muted">Valid clicks</dt><dd className="font-semibold text-ink">{c.report.clicks.valid} <span className="font-normal text-muted">({pct(c.report.clicks.invalidSharePct)} invalid)</span></dd></div>
                        <div><dt className="text-xs text-muted">Cost per enquiry</dt><dd className="font-semibold text-ink">{c.report.costPerEnquiryPaise === null ? "-" : inr(c.report.costPerEnquiryPaise)}</dd></div>
                      </dl>
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted">Campaign status reasons appear on each campaign page. {HALT_TEXT.wallet}</p>
      </section>

      <section aria-labelledby="rates" className="space-y-3">
        <h2 id="rates" className="text-lg font-bold text-ink">Price per click (public rate card)</h2>
        {!rates.ok ? <Alert tone="danger">{rates.error}</Alert> : rates.data.length === 0 ? <p className="text-sm text-muted">Prices have not been published yet.</p> : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Fixed price per click by category and placement</caption>
              <thead className="bg-canvas text-xs uppercase text-muted"><tr><th scope="col" className="p-3">Category</th><th scope="col" className="p-3">Where</th><th scope="col" className="p-3 text-right">Per click</th></tr></thead>
              <tbody>
                {rates.data.map((r) => (
                  <tr key={`${r.categoryId}-${r.surface}`} className="border-t border-line"><td className="p-3 text-ink">{r.categoryName}</td><td className="p-3 text-muted">{SURFACE_LABEL[r.surface] ?? r.surface}</td><td className="p-3 text-right font-semibold text-ink">{inr(r.cpcPaise)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">
          There is no bidding: everyone pays the same price, so paying more does not rank you higher. Ads need a verified business
          {cfg.ok ? ` (tier ${cfg.data.minVerificationTier} or higher) with a trust score of at least ${cfg.data.trustFloor}` : ""}. Prices exclude GST.
        </p>
      </section>

      <section aria-labelledby="wallet" className="space-y-3">
        <h2 id="wallet" className="text-lg font-bold text-ink">Wallet activity</h2>
        {!ledger.ok ? <Alert tone="danger">{ledger.error}</Alert> : ledger.data.length === 0 ? <p className="text-sm text-muted">No wallet activity yet.</p> : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {ledger.data.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span><span className="font-medium text-ink">{REASON[e.reason] ?? e.reason}</span><span className="block text-xs text-muted">{formatDateTime(e.createdAt)}{e.expiresAt ? ` · expires ${formatDateTime(e.expiresAt)}` : ""}</span></span>
                <span className={e.deltaPaise < 0 ? "font-semibold text-ink" : "font-semibold text-success"}>{e.deltaPaise < 0 ? "-" : "+"}{inr(Math.abs(e.deltaPaise))}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">Paid balance never expires and can be refunded on request. Promo credit expires after 90 days. Auto top-up is off and will only be switched on by you, with a cap.</p>
      </section>
    </div>
  );
}
