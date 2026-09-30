import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, buttonClasses, Card, CardBody, EmptyState, Money, PageHeader, Stat } from "@cnote/ui";
import { getAdvertiserOverview, getAdsConfig, getPublicRateCard, isAdsEnabled } from "@cnote/ads";
import { getAdWalletBalance, getAdWalletLedger } from "@cnote/billing";
import { getLocale, getTranslations } from "next-intl/server";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { inr, labelOf, pct, STATUS_TONE } from "@/features/ads/format";
import { intlTag } from "@/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ads.meta");
  return { title: t("title") };
}

export default async function AdsPage() {
  const session = await requireSeller("/ads");
  const t = await getTranslations("ads");
  const l = await getLocale();
  const dtf = new Intl.DateTimeFormat(intlTag(l), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const formatDateTime = (iso: Date | string) => dtf.format(new Date(iso));
  if (!isAdsEnabled()) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("meta.title")} description={t("list.offDescription")} />
        <EmptyState
          title={t("comingSoon.title")}
          description={t("list.offComingSoonDesc")}
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
        title={t("meta.title")}
        description={t("list.description")}
        actions={<Link href="/ads/new" className={buttonClasses("primary")}>{t("list.create")}</Link>}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("list.wallet")} value={balance.ok ? <Money paise={balance.data} className="text-2xl" /> : "-"} hint={t("list.walletHint")} />
        <Stat label={t("list.spend30")} value={inr(total, l)} hint={t("list.spend30Hint")} />
        <Stat label={t("list.campaigns")} value={overview.ok ? overview.data.length : "-"} />
      </div>
      {!balance.ok ? <Alert tone="danger">{balance.error}</Alert> : null}
      {balance.ok && balance.data <= 0 ? (
        <Alert tone="warning">{t("list.walletEmpty")}</Alert>
      ) : null}

      <section aria-labelledby="campaigns" className="space-y-3">
        <h2 id="campaigns" className="text-lg font-bold text-ink">{t("list.yourCampaigns")}</h2>
        {!overview.ok ? <Alert tone="danger">{overview.error}</Alert> : overview.data.length === 0 ? (
          <EmptyState title={t("list.noCampaigns")} description={t("list.noCampaignsDesc")} action={<Link href="/ads/new" className={buttonClasses("primary")}>{t("list.create")}</Link>} />
        ) : (
          <ul className="space-y-3">
            {overview.data.map((c) => {
              const s = { label: labelOf(t, "status", c.status), tone: STATUS_TONE[c.status] ?? ("neutral" as const) };
              return (
                <li key={c.id}>
                  <Card>
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <Link href={`/ads/${c.id}`} className="font-semibold text-ink underline-offset-2 hover:underline">{c.name}</Link>
                        <div className="flex flex-wrap items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge></div>
                      </div>
                      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                        <div><dt className="text-xs text-muted">{t("list.spendCol")}</dt><dd className="font-semibold text-ink">{inr(c.report.spendPaise, l)}</dd></div>
                        <div><dt className="text-xs text-muted">{t("list.validClicks")}</dt><dd className="font-semibold text-ink">{c.report.clicks.valid} <span className="font-normal text-muted">{t("list.invalidShare", { pct: pct(c.report.clicks.invalidSharePct, l) })}</span></dd></div>
                        <div><dt className="text-xs text-muted">{t("list.costPerEnquiry")}</dt><dd className="font-semibold text-ink">{c.report.costPerEnquiryPaise === null ? "-" : inr(c.report.costPerEnquiryPaise, l)}</dd></div>
                      </dl>
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted">{t("list.statusNote")} {t("halt.wallet")}</p>
      </section>

      <section aria-labelledby="rates" className="space-y-3">
        <h2 id="rates" className="text-lg font-bold text-ink">{t("list.ratesHeading")}</h2>
        {!rates.ok ? <Alert tone="danger">{rates.error}</Alert> : rates.data.length === 0 ? <p className="text-sm text-muted">{t("list.ratesNone")}</p> : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t("list.ratesCaption")}</caption>
              <thead className="bg-canvas text-xs uppercase text-muted"><tr><th scope="col" className="p-3">{t("list.colCategory")}</th><th scope="col" className="p-3">{t("list.colWhere")}</th><th scope="col" className="p-3 text-right">{t("list.colPerClick")}</th></tr></thead>
              <tbody>
                {rates.data.map((r) => (
                  <tr key={`${r.categoryId}-${r.surface}`} className="border-t border-line"><td className="p-3 text-ink">{r.categoryName}</td><td className="p-3 text-muted">{labelOf(t, "surface", r.surface)}</td><td className="p-3 text-right font-semibold text-ink">{inr(r.cpcPaise, l)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">
          {cfg.ok ? t("list.ratesNoteCfg", { tier: cfg.data.minVerificationTier, floor: cfg.data.trustFloor }) : t("list.ratesNote")}
        </p>
      </section>

      <section aria-labelledby="wallet" className="space-y-3">
        <h2 id="wallet" className="text-lg font-bold text-ink">{t("list.walletActivity")}</h2>
        {!ledger.ok ? <Alert tone="danger">{ledger.error}</Alert> : ledger.data.length === 0 ? <p className="text-sm text-muted">{t("list.noWallet")}</p> : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {ledger.data.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span><span className="font-medium text-ink">{labelOf(t, "ledger", e.reason)}</span><span className="block text-xs text-muted">{formatDateTime(e.createdAt)}{e.expiresAt ? ` · ${t("list.expires", { date: formatDateTime(e.expiresAt) })}` : ""}</span></span>
                <span className={e.deltaPaise < 0 ? "font-semibold text-ink" : "font-semibold text-success"}>{e.deltaPaise < 0 ? "-" : "+"}{inr(Math.abs(e.deltaPaise), l)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t("list.walletFooter")}</p>
      </section>
    </div>
  );
}
