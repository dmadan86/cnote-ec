import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, type BadgeTone } from "@cnote/ui";
import {
  blockingVerticals, checklistProgress, CHECKLIST_SECTIONS, evaluateVerticalGates, getVertical, listChecklist, listSnapshots, listStageChanges, STAGE_TRANSITIONS,
} from "@cnote/verticals";
import { notFound } from "next/navigation";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";
import { AddItemForm, ChecklistRow, EditVerticalForm, StageForm } from "../forms";

export const metadata = { title: "Vertical" };
const TONE: Record<string, BadgeTone> = { candidate: "neutral", pilot: "warning", open: "success", paused: "danger" };
const ok = (b: boolean) => <Badge tone={b ? "success" : "warning"}>{b ? "met" : "not met"}</Badge>;

export default async function VerticalPage({ params }: PageProps<"/verticals/[id]">) {
  const { id } = await params;
  await requireStaff(`/verticals/${id}`, "verticals.manage");
  const v = await safe("verticals.get", () => getVertical(id));
  if (!v) notFound();
  const [gate, blockers, items, progress, trend, changes] = await Promise.all([
    safe("verticals.gates", () => evaluateVerticalGates(id)),
    safe("verticals.blockers", () => blockingVerticals(id)),
    safe("verticals.checklist", () => listChecklist(id)),
    safe("verticals.progress", () => checklistProgress(id)),
    safe("verticals.trend", () => listSnapshots(id, 120)),
    safe("verticals.changes", () => listStageChanges(id)),
  ]);
  const max = Math.max(1, ...(trend ?? []).map((t) => t.verifiedSellers));
  return (
    <>
      <PageHeader title={v.name} description={`${v.slug} · covers ${v.categorySlugs.join(", ")} · languages ${v.languages.join(" > ")} · since ${fmtDate(v.stageChangedAt)}`} actions={<Badge tone={TONE[v.stage] ?? "neutral"}>{v.stage}</Badge>} />

      <section aria-labelledby="gates" className="space-y-3">
        <h2 id="gates" className="text-sm font-semibold uppercase tracking-wide text-muted">Gates (live)</h2>
        {gate === null ? <Alert tone="warning">Gate metrics are unavailable right now.</Alert> : (
          <Table>
            <thead><tr><Th>Gate</Th><Th>Now</Th><Th>Required</Th><Th>Status</Th></tr></thead>
            <tbody>
              <tr><Td>Verified sellers (tier 1+, live listing)</Td><Td>{gate.verifiedSellers}</Td><Td>{gate.thresholds.minVerifiedSellers}</Td><Td>{ok(gate.checks.verifiedSellers)}</Td></tr>
              <tr><Td>Net adds, trailing 30 days</Td><Td>{gate.netAdds30 ?? "no history"}</Td><Td>{gate.thresholds.minNetAdds30}</Td><Td>{ok(gate.checks.netAdds30)}</Td></tr>
              <tr><Td>Net adds, trailing 90 days</Td><Td>{gate.netAdds90 ?? "no history"}</Td><Td>{gate.thresholds.minNetAdds90}</Td><Td>{ok(gate.checks.netAdds90)}</Td></tr>
            </tbody>
          </Table>
        )}
        {gate && (gate.baselineDays30 !== null && gate.baselineDays30 < 30) ? <p className="text-xs text-muted">Net adds use a partial window (baseline {gate.baselineDays30} days old) until 30 days of snapshots exist.</p> : null}
      </section>

      <section aria-labelledby="trend" className="space-y-3">
        <h2 id="trend" className="text-sm font-semibold uppercase tracking-wide text-muted">Trend (daily snapshots)</h2>
        {!trend || trend.length === 0 ? <Alert tone="info">No snapshots yet. The daily job writes one per vertical.</Alert> : (
          <Table>
            <thead><tr><Th>Day</Th><Th>Verified sellers</Th><Th className="w-1/2">Relative</Th><Th>30d</Th><Th>90d</Th><Th>Gates</Th></tr></thead>
            <tbody>
              {trend.slice(-30).reverse().map((t) => (
                <tr key={t.day}>
                  <Td>{t.day}</Td><Td>{t.verifiedSellers}</Td>
                  <Td><div className="h-2 rounded bg-brand-600" style={{ width: `${Math.round((t.verifiedSellers / max) * 100)}%` }} role="img" aria-label={`${t.verifiedSellers} of max ${max}`} /></Td>
                  <Td>{t.netAdds30 ?? "n/a"}</Td><Td>{t.netAdds90 ?? "n/a"}</Td><Td>{ok(t.meetsGates)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="stage" className="space-y-3">
        <h2 id="stage" className="text-sm font-semibold uppercase tracking-wide text-muted">Stage</h2>
        {blockers && blockers.length > 0 ? (
          <Alert tone="warning">Open verticals missing their gates: {blockers.map((b) => b.slug).join(", ")}. Moving this vertical to pilot or open needs an override reason.</Alert>
        ) : null}
        <Card><CardBody><StageForm id={v.id} options={[...STAGE_TRANSITIONS[v.stage]]} blocked={(blockers?.length ?? 0) > 0} /></CardBody></Card>
        {changes && changes.length > 0 ? (
          <Table>
            <thead><tr><Th>When (IST)</Th><Th>Change</Th><Th>By</Th><Th>Override reason</Th></tr></thead>
            <tbody>{changes.map((c) => <tr key={c.id}><Td>{fmtDate(c.createdAt)}</Td><Td>{c.from} to {c.to}</Td><Td className="font-mono text-xs">{c.changedBy.slice(0, 8)}</Td><Td>{c.overridden ? c.overrideReason : "-"}</Td></tr>)}</tbody>
          </Table>
        ) : null}
      </section>

      <section aria-labelledby="checklist" className="space-y-3">
        <h2 id="checklist" className="text-sm font-semibold uppercase tracking-wide text-muted">Playbook checklist{progress ? ` (${progress.done}/${progress.total})` : ""}</h2>
        {items === null ? <Alert tone="warning">Checklist unavailable.</Alert> : CHECKLIST_SECTIONS.map((sec) => {
          const rows = items.filter((i) => i.section === sec);
          return (
            <Card key={sec}>
              <CardHeader><CardTitle>{sec} {progress ? `(${progress.bySection[sec].done}/${progress.bySection[sec].total})` : ""}</CardTitle></CardHeader>
              <CardBody>{rows.length === 0 ? <p className="text-sm text-muted">No items.</p> : rows.map((i) => <ChecklistRow key={i.id} verticalId={v.id} item={i} />)}</CardBody>
            </Card>
          );
        })}
        <AddItemForm id={v.id} />
      </section>

      <section aria-labelledby="config" className="space-y-3">
        <h2 id="config" className="text-sm font-semibold uppercase tracking-wide text-muted">Configuration</h2>
        <Card><CardBody>
          <EditVerticalForm v={{
            id: v.id, name: v.name, categorySlugs: v.categorySlugs.join(", "), languages: v.languages.join(", "),
            clusters: v.clusters.map((c) => [c.label, c.city, c.industry, c.district ?? "", c.state ?? ""].join(" | ").replace(/( \| )+$/, "")).join("\n"),
            attributeSchemaSlug: v.attributeSchemaSlug ?? "", notes: v.notes ?? "", minVerifiedSellers: v.gates.minVerifiedSellers, minNetAdds30: v.gates.minNetAdds30, minNetAdds90: v.gates.minNetAdds90,
            prohibitedModelVersion: v.classifierConfig.prohibitedModelVersion ?? "", intentModelVersion: v.classifierConfig.intentModelVersion ?? "", classifierNotes: v.classifierConfig.notes ?? "",
          }} />
        </CardBody></Card>
      </section>
    </>
  );
}
