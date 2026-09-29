import type { Metadata } from "next";
import Link from "next/link";
import { getTrafficSummaryForSeller } from "@cnote/domains";
import { Alert, Card, CardBody, CardHeader, CardTitle, EmptyState, LinkTabs, PageHeader, Stat } from "@cnote/ui";
import { BarList, TrafficChart } from "@/features/domains/charts";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";

export const metadata: Metadata = { title: "Storefront traffic" };
export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;
const SOURCE_LABELS: Record<string, string> = {
  organic_search: "Search engines (Google, Bing)",
  social: "Social media",
  ai_assistant: "AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot)",
  paid: "Paid ads",
  email: "Email",
  referral: "Other websites",
  direct: "Direct (typed or bookmarked)",
};
const DEVICE_LABELS: Record<string, string> = { mobile: "Mobile", desktop: "Desktop", tablet: "Tablet" };
const HOST_LABELS: Record<string, string> = { custom: "Your own domain", subdomain: "Free address", path: "Marketplace link" };
const n = (v: number) => v.toLocaleString("en-IN");

export default async function AnalyticsPage({ searchParams }: PageProps<"/storefront/analytics">) {
  const sp = await searchParams;
  const raw = Number(Array.isArray(sp.range) ? sp.range[0] : sp.range);
  const days = (RANGES as readonly number[]).includes(raw) ? raw : 30;
  const session = await requireSeller("/storefront/analytics");
  const res = await load(() => getTrafficSummaryForSeller(session.business.id, { days }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Storefront traffic"
        description="Who visits your storefront and where they come from. We do not use cookies or store IP addresses; visitors are counted with a hash that changes every day."
        actions={<Link href="/storefront/domains" className="text-sm font-medium text-brand-700 hover:underline">Custom domain</Link>}
      />
      <LinkTabs label="Date range" items={RANGES.map((r) => ({ href: `/storefront/analytics?range=${r}`, label: `Last ${r} days`, active: r === days }))} />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : !res.data ? (
        <EmptyState title="No storefront yet" description="Publish your storefront and traffic will show up here." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Visitors" value={n(res.data.totals.uniqueVisitors)} hint="Unique per day, added up" />
            <Stat label="Page views" value={n(res.data.totals.pageviews)} />
            <Stat label="Requests served" value={n(res.data.totals.requests)} hint="All requests, incl. crawlers and files" />
            <Stat label="Enquiries" value={n(res.data.totals.enquiries)} hint="Started from your storefront" />
          </div>
          <Card>
            <CardHeader><CardTitle>Visitors and page views</CardTitle></CardHeader>
            <CardBody>{res.data.totals.requests === 0 ? <p className="text-sm text-muted">No visits recorded in this period yet. Numbers update every few minutes.</p> : <TrafficChart series={res.data.series} />}</CardBody>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardBody><BarList title="Where visitors come from" items={res.data.bySource} labels={SOURCE_LABELS} /></CardBody></Card>
            <Card><CardBody><BarList title="Top referrers" items={res.data.byReferrer} empty="No referrers yet." /></CardBody></Card>
            <Card><CardBody><BarList title="Top pages" items={res.data.byPage} /></CardBody></Card>
            <Card><CardBody><BarList title="Devices" items={res.data.byDevice} labels={DEVICE_LABELS} /></CardBody></Card>
            <Card><CardBody className="space-y-2">
              <BarList title="Crawler and AI bot visits" items={res.data.bots} empty="No crawler visits yet." />
              <p className="text-xs text-muted">Search engines and AI assistants (for example Googlebot, GPTBot, ClaudeBot, PerplexityBot) read your storefront so you can be found. They are counted here, not as visitors. {n(res.data.totals.botHits)} bot visits in this period.</p>
            </CardBody></Card>
            <Card><CardBody><BarList title="Address used" items={res.data.byHostKind} labels={HOST_LABELS} /></CardBody></Card>
          </div>
        </>
      )}
    </div>
  );
}
