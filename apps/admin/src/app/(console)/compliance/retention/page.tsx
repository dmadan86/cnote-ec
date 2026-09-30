import { hasPrivilege } from "@cnote/admin";
import { describePolicies, listRetentionRuns } from "@cnote/compliance";
import { Alert, Badge, EmptyState } from "@cnote/ui";
import { RetentionDryRunForm } from "@/features/compliance/forms";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Retention" };

export default async function RetentionPage() {
  const { staff } = await requireStaff("/compliance/retention", "compliance.read");
  const policies = describePolicies();
  const runs = await safe("compliance.listRetentionRuns", () => listRetentionRuns(100));
  return (
    <div className="space-y-6">
      <section aria-labelledby="sched" className="space-y-3">
        <h2 id="sched" className="text-lg font-semibold">Retention schedule</h2>
        <Table>
          <thead><tr><Th>Policy</Th><Th>Window</Th><Th>Description</Th><Th>Legal basis</Th></tr></thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.name}>
                <Td><Mono>{p.name}</Mono></Td>
                <Td className="whitespace-nowrap">{p.windowDays} days</Td>
                <Td>{p.description}{p.supportsDryRun ? null : <Badge tone="warning" className="ml-1">no dry-run</Badge>}</Td>
                <Td className="text-muted">{p.legalBasis}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {hasPrivilege(staff, "compliance.manage") ? <RetentionDryRunForm policies={policies.map((p) => p.name)} /> : <Alert tone="info">Your role can&apos;t trigger dry-runs.</Alert>}
      </section>
      <section aria-labelledby="runs" className="space-y-3">
        <h2 id="runs" className="text-lg font-semibold">Run log</h2>
        {runs === null ? <Alert tone="warning">The run log is currently unavailable.</Alert> : null}
        {runs && runs.length === 0 ? <EmptyState title="No runs yet" description="The scheduled job records one row per policy per run." /> : null}
        {runs?.length ? (
          <Table>
            <thead><tr><Th>Started</Th><Th>Policy</Th><Th>Rows</Th><Th>Result</Th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{fmtDate(r.startedAt)}</Td>
                  <Td><Mono>{r.policy}</Mono></Td>
                  <Td>{r.purged}</Td>
                  <Td>{r.error ? <Badge tone="danger">Failed: {r.error}</Badge> : <Badge tone="success">OK</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </section>
    </div>
  );
}
