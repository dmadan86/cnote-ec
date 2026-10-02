import { listDisputeQueue, disputeMetrics, type DisputeStatus } from "@/lib/disputes";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, Stat, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { inr } from "@/features/payments/format";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Disputes" };
export const dynamic = "force-dynamic";

const STATUSES: DisputeStatus[] = ["awaiting_adjudication", "auto_resolved", "evidence", "open", "resolved", "withdrawn"];
const TONE: Record<string, BadgeTone> = { resolved: "success", withdrawn: "neutral", awaiting_adjudication: "warning", auto_resolved: "brand", open: "brand", evidence: "brand" };
const since = (days: number) => new Date(Date.now() - days * 86_400_000);
const eta = (ms: number) => { const h = Math.round(Math.abs(ms) / 3_600_000); return h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`; };

export default async function DisputesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === one(sp.status));
  await requireStaff("/disputes", "disputes.read");
  const [rows, m] = await Promise.all([
    safe("disputes.queue", () => listDisputeQueue({ status, limit: 100 })),
    safe("disputes.metrics", () => disputeMetrics({ from: since(90) })),
  ]);
  const q = (s?: string) => (s ? `/disputes?status=${s}` : "/disputes");
  return (
    <>
      <PageHeader title="Disputes" description="ADR-013 queue, soonest SLA deadline first. Cases wait here for a decision after the AI brief; auto-resolutions apply after the 48h escalation window." />
      {m ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Median time to resolution (90d)" value={m.medianResolutionDays === null ? "-" : `${m.medianResolutionDays.toFixed(1)}d`} hint={`Target ${m.targetDays}d${m.meetsTarget === false ? " (missed)" : ""}`} />
          <Stat label="Resolved / opened" value={`${m.resolved} / ${m.opened}`} />
          <Stat label="Overdue and active" value={m.overdueActive} />
          <Stat label="AI recommendation followed" value={m.briefAgreementRate === null ? "-" : `${Math.round(m.briefAgreementRate * 100)}%`} />
        </div>
      ) : null}
      <LinkTabs label="Status" items={[{ href: q(), label: "All", active: !status }, ...STATUSES.map((s) => ({ href: q(s), label: s.replace(/_/g, " "), active: s === status }))]} />
      {rows === null ? <Alert tone="warning">Disputes are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No disputes" description="Nothing matches this filter." /> : (
        <Table>
          <thead><tr><Th>Case</Th><Th>Type</Th><Th>Amount held</Th><Th>Claimed</Th><Th>AI confidence</Th><Th>SLA</Th><Th>Status</Th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <Td><Link href={`/disputes/${d.id}`} className="font-medium text-brand-700 hover:underline"><Mono>{shortId(d.id)}</Mono></Link>{d.hasOpenAppeal ? <Badge tone="danger" className="ml-2">appeal</Badge> : null}{d.escalated ? <Badge tone="warning" className="ml-2">escalated</Badge> : null}</Td>
                <Td>{d.type.replace(/_/g, " ")}</Td>
                <Td className="tabular-nums">{inr(d.atStakePaise)}</Td>
                <Td className="tabular-nums">{d.amountPaise === null ? "-" : inr(d.amountPaise)}</Td>
                <Td className="tabular-nums">{d.briefConfidence === null ? "-" : d.briefConfidence.toFixed(2)}</Td>
                <Td className="whitespace-nowrap">{["resolved", "withdrawn"].includes(d.status) ? fmtDate(d.createdAt) : d.overdue ? <Badge tone="danger">overdue {eta(d.msToDue)}</Badge> : `due in ${eta(d.msToDue)}`}</Td>
                <Td><Badge tone={TONE[d.status] ?? "neutral"}>{d.status.replace(/_/g, " ")}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
