import { hasPrivilege } from "@cnote/admin";
import { getScorecard, listAlerts } from "@cnote/metrics";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Table, Td, Th } from "@/components/table";
import { AlertsTable } from "@/features/metrics/alerts-table";
import { STATUS_LABEL, STATUS_TONE, formatTarget, formatValue } from "@/features/metrics/format";
import { Sparkline } from "@/features/metrics/sparkline";
import { requireStaff } from "@/lib/auth";
import { one, safe } from "@/lib/util";

export const metadata = { title: "Metrics" };

export default async function MetricsPage({ searchParams }: PageProps<"/metrics">) {
  const sp = await searchParams;
  const alertView = one(sp.alerts) === "all" ? "all" : "open";
  const { staff } = await requireStaff(`/metrics${alertView === "all" ? "?alerts=all" : ""}`, "metrics.read");
  const [card, alerts] = await Promise.all([
    safe("metrics.scorecard", () => getScorecard()),
    safe("metrics.alerts", () => listAlerts({ open: alertView === "open" ? true : undefined, limit: 100 })),
  ]);
  const gate = card?.filter((c) => c.gate) ?? [];
  const other = card?.filter((c) => !c.gate) ?? [];

  const rows = (list: NonNullable<typeof card>) =>
    list.map((c) => (
      <tr key={c.id}>
        <Td className="font-medium">
          <Link href={`/metrics/${c.id}`} className="text-brand-700 hover:underline">{c.title}</Link>
          <div className="text-xs font-normal text-muted">{c.windowDays > 0 ? `${c.windowDays}-day window` : "same-day"}</div>
        </Td>
        <Td className="whitespace-nowrap">{c.adr}</Td>
        <Td className="text-right tabular-nums">
          {formatValue(c.unit, c.latest?.value)}
          {c.latest ? <div className="text-xs text-muted">{c.latest.day}{c.latest.denominator != null ? ` · n=${c.latest.denominator}` : ""}</div> : null}
        </Td>
        <Td className="text-right tabular-nums">{formatTarget(c.unit, c.target)}</Td>
        <Td><Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge></Td>
        <Td className="text-right tabular-nums">{formatValue(c.unit, c.avg7)}</Td>
        <Td className="text-right tabular-nums">{formatValue(c.unit, c.avg28)}</Td>
        <Td><Sparkline label={c.title} unit={c.unit} series={c.series} /></Td>
      </tr>
    ));
  const head = (
    <thead>
      <tr>
        <Th>Metric</Th><Th>ADR</Th><Th className="text-right">Latest</Th><Th className="text-right">Target</Th><Th>Status</Th>
        <Th className="text-right">7-day</Th><Th className="text-right">28-day</Th><Th>28-day trend</Th>
      </tr>
    </thead>
  );

  return (
    <>
      <PageHeader
        title="Phase 1 gate"
        description="ADR success metrics computed daily from the domain event log. Days are IST. Values use the latest day whose follow-up window has closed; deal outcomes are self-reported by sellers."
      />
      {card === null ? <Alert tone="warning">Metrics are currently unavailable.</Alert> : null}
      {card && gate.every((g) => g.status === "no_data") ? (
        <Alert tone="info">No metric data yet. The worker computes metrics every 15 minutes; to load history run <code>pnpm --filter @cnote/metrics backfill -- --from YYYY-MM-DD</code>.</Alert>
      ) : null}
      {card ? (
        <>
          <section aria-labelledby="gate" className="flex flex-col gap-2">
            <h2 id="gate" className="text-base font-bold">Gate metrics</h2>
            <Table><caption className="sr-only">Phase 1 gate metrics against ADR targets</caption>{head}<tbody>{rows(gate)}</tbody></Table>
          </section>
          <section aria-labelledby="ctx" className="flex flex-col gap-2">
            <h2 id="ctx" className="text-base font-bold">Supporting metrics</h2>
            <Table><caption className="sr-only">Supporting funnel, moderation and volume metrics</caption>{head}<tbody>{rows(other)}</tbody></Table>
          </section>
        </>
      ) : null}
      <section aria-labelledby="alerts" className="flex flex-col gap-2">
        <h2 id="alerts" className="text-base font-bold">Alerts</h2>
        <LinkTabs
          label="Alert filter"
          variant="underline"
          items={[{ href: "/metrics", label: "Open", active: alertView === "open" }, { href: "/metrics?alerts=all", label: "All", active: alertView === "all" }]}
        />
        {alerts === null ? (
          <Alert tone="warning">Alerts are currently unavailable.</Alert>
        ) : alerts.length === 0 ? (
          <EmptyState title={alertView === "open" ? "No open alerts" : "No alerts"} description="An alert is raised when a metric with a closed window breaches its threshold." />
        ) : (
          <AlertsTable alerts={alerts} canResolve={hasPrivilege(staff, "metrics.read")} />
        )}
      </section>
    </>
  );
}
