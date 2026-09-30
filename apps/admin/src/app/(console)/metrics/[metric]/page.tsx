import { getDefinition, getDimensionBreakdown, getMetricSeries, istDay, addDays, listAlerts } from "@cnote/metrics";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mono, Table, Td, Th } from "@/components/table";
import { AlertsTable } from "@/features/metrics/alerts-table";
import { RANGES, formatTarget, formatValue, parseRange } from "@/features/metrics/format";
import { Sparkline } from "@/features/metrics/sparkline";
import { requireStaff } from "@/lib/auth";
import { one, safe } from "@/lib/util";

export async function generateMetadata({ params }: PageProps<"/metrics/[metric]">) {
  const { metric } = await params;
  return { title: getDefinition(metric)?.title ?? "Metric" };
}

export default async function MetricDetailPage({ params, searchParams }: PageProps<"/metrics/[metric]">) {
  const { metric } = await params;
  const def = getDefinition(metric);
  if (!def) notFound();
  const days = parseRange(one((await searchParams).days));
  const { staff } = await requireStaff(`/metrics/${metric}?days=${days}`, "metrics.read");
  const to = istDay();
  const from = addDays(to, -(days - 1));
  const [series, breakdown, alerts] = await Promise.all([
    safe("metrics.series", () => getMetricSeries(def.id, { from, to })),
    def.dimensions.length ? safe("metrics.breakdown", () => getDimensionBreakdown(def.id, { from, to })) : [],
    safe("metrics.alerts", async () => (await listAlerts({ limit: 200 })).filter((a) => a.metric === def.id).slice(0, 20)),
  ]);

  return (
    <>
      <PageHeader
        title={def.title}
        description={
          <>
            <Link href="/metrics" className="text-brand-700 hover:underline">Metrics</Link> · {def.adr}
            {def.target ? <> · Target {formatTarget(def.unit, def.target)}</> : null}
          </>
        }
      />
      <LinkTabs label="Date range" items={RANGES.map((d) => ({ href: `/metrics/${metric}?days=${d}`, label: `Last ${d} days`, active: d === days }))} />
      <Card>
        <CardHeader><CardTitle>Definition</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-sm">
          <p>{def.description}</p>
          <p><span className="font-semibold">Formula: </span><Mono>{def.formula}</Mono></p>
          <p className="text-muted">
            {def.windowDays > 0
              ? `Follow-up window ${def.windowDays} days: a day's value can still change until ${def.windowDays} days after it. Recent days are provisional.`
              : "Same-day metric: computed from events on the day; late events are picked up on recompute."}
          </p>
        </CardBody>
      </Card>
      <section aria-labelledby="series" className="flex flex-col gap-2">
        <h2 id="series" className="text-base font-bold">Daily values</h2>
        {series === null ? (
          <Alert tone="warning">The series is currently unavailable.</Alert>
        ) : series.length === 0 ? (
          <EmptyState title="No data in this period" description="Days without qualifying events have no value. Run a backfill to load history." />
        ) : (
          <>
            <Sparkline label={def.title} unit={def.unit} series={series} width={480} height={80} />
            <Table>
              <caption className="sr-only">{def.title} by day, last {days} days</caption>
              <thead><tr><Th>Day (IST)</Th><Th className="text-right">Value</Th><Th className="text-right">Numerator</Th><Th className="text-right">Denominator</Th><Th>Vs target</Th></tr></thead>
              <tbody>
                {[...series].reverse().map((p) => (
                  <tr key={p.day}>
                    <Td className="whitespace-nowrap">{p.day}</Td>
                    <Td className="text-right tabular-nums">{formatValue(def.unit, p.value)}</Td>
                    <Td className="text-right tabular-nums">{p.numerator ?? "—"}</Td>
                    <Td className="text-right tabular-nums">{p.denominator ?? "—"}</Td>
                    <Td>
                      {def.target ? (
                        (def.target.direction === "at_least" ? p.value >= def.target.value : p.value < def.target.value) ? <Badge tone="success">On target</Badge> : <Badge tone="danger">Off target</Badge>
                      ) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </section>
      {def.dimensions.length ? (
        <section aria-labelledby="dims" className="flex flex-col gap-2">
          <h2 id="dims" className="text-base font-bold">By category</h2>
          {breakdown === null ? (
            <Alert tone="warning">The breakdown is currently unavailable.</Alert>
          ) : breakdown.length === 0 ? (
            <p className="text-sm text-muted">No category data in this period.</p>
          ) : (
            <Table>
              <caption className="sr-only">{def.title} by category, last {days} days (pooled)</caption>
              <thead><tr><Th>Category</Th><Th className="text-right">Value</Th><Th className="text-right">Numerator</Th><Th className="text-right">Denominator</Th></tr></thead>
              <tbody>
                {breakdown.map((b) => (
                  <tr key={b.dimension}>
                    <Td><Mono>{b.dimension.replace(/^category:/, "")}</Mono></Td>
                    <Td className="text-right tabular-nums">{formatValue(def.unit, b.value)}</Td>
                    <Td className="text-right tabular-nums">{b.numerator ?? "—"}</Td>
                    <Td className="text-right tabular-nums">{b.denominator ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      ) : null}
      {alerts && alerts.length ? (
        <section aria-labelledby="alerts" className="flex flex-col gap-2">
          <h2 id="alerts" className="text-base font-bold">Alerts for this metric</h2>
          <AlertsTable alerts={alerts} canResolve={hasPrivilege(staff, "metrics.read")} />
        </section>
      ) : null}
    </>
  );
}
