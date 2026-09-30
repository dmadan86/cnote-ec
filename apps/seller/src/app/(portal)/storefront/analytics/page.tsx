import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { getTrafficSummaryForSeller } from "@cnote/domains";
import { Alert, Card, CardBody, CardHeader, CardTitle, EmptyState, LinkTabs, PageHeader, Stat } from "@cnote/ui";
import { type Locale, intlTag } from "@/i18n/config";
import { BarList, TrafficChart } from "@/features/domains/charts";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("storefront.analytics");
  return { title: t("metaTitle") };
}
export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;
const SOURCES = ["organic_search", "social", "ai_assistant", "paid", "email", "referral", "direct"] as const;
const DEVICES = ["mobile", "desktop", "tablet"] as const;
const HOSTS = ["custom", "subdomain", "path"] as const;

export default async function AnalyticsPage({ searchParams }: PageProps<"/storefront/analytics">) {
  const t = await getTranslations("storefront.analytics");
  const locale = (await getLocale()) as Locale;
  const n = (v: number) => v.toLocaleString(intlTag(locale));
  const SOURCE_LABELS = Object.fromEntries(SOURCES.map((k) => [k, t(`source.${k}`)]));
  const DEVICE_LABELS = Object.fromEntries(DEVICES.map((k) => [k, t(`device.${k}`)]));
  const HOST_LABELS = Object.fromEntries(HOSTS.map((k) => [k, t(`host.${k}`)]));
  const sp = await searchParams;
  const raw = Number(Array.isArray(sp.range) ? sp.range[0] : sp.range);
  const days = (RANGES as readonly number[]).includes(raw) ? raw : 30;
  const session = await requireSeller("/storefront/analytics");
  const res = await load(() => getTrafficSummaryForSeller(session.business.id, { days }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<Link href="/storefront/domains" className="text-sm font-medium text-brand-700 hover:underline">{t("customDomain")}</Link>}
      />
      <LinkTabs label={t("dateRange")} items={RANGES.map((r) => ({ href: `/storefront/analytics?range=${r}`, label: t("lastDays", { days: r }), active: r === days }))} />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : !res.data ? (
        <EmptyState title={t("noStorefrontTitle")} description={t("noStorefrontDesc")} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("visitors")} value={n(res.data.totals.uniqueVisitors)} hint={t("visitorsHint")} />
            <Stat label={t("pageViews")} value={n(res.data.totals.pageviews)} />
            <Stat label={t("requests")} value={n(res.data.totals.requests)} hint={t("requestsHint")} />
            <Stat label={t("enquiries")} value={n(res.data.totals.enquiries)} hint={t("enquiriesHint")} />
          </div>
          <Card>
            <CardHeader><CardTitle>{t("chartTitle")}</CardTitle></CardHeader>
            <CardBody>{res.data.totals.requests === 0 ? <p className="text-sm text-muted">{t("noVisits")}</p> : <TrafficChart series={res.data.series} />}</CardBody>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardBody><BarList title={t("whereFrom")} items={res.data.bySource} labels={SOURCE_LABELS} /></CardBody></Card>
            <Card><CardBody><BarList title={t("topReferrers")} items={res.data.byReferrer} empty={t("noReferrers")} /></CardBody></Card>
            <Card><CardBody><BarList title={t("topPages")} items={res.data.byPage} /></CardBody></Card>
            <Card><CardBody><BarList title={t("devices")} items={res.data.byDevice} labels={DEVICE_LABELS} /></CardBody></Card>
            <Card><CardBody className="space-y-2">
              <BarList title={t("bots")} items={res.data.bots} empty={t("noBots")} />
              <p className="text-xs text-muted">{t("botNote", { count: n(res.data.totals.botHits) })}</p>
            </CardBody></Card>
            <Card><CardBody><BarList title={t("addressUsed")} items={res.data.byHostKind} labels={HOST_LABELS} /></CardBody></Card>
          </div>
        </>
      )}
    </div>
  );
}
