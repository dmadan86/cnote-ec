import { listIssues } from "@cnote/escrow";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { ResolveIssueForm, RunReconciliationForm } from "@/features/escrow/forms";
import { inr } from "@/features/payments/format";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Escrow reconciliation" };
export const dynamic = "force-dynamic";

export default async function ReconciliationPage({ searchParams }: PageProps<"/escrow/reconciliation">) {
  const sp = await searchParams;
  const status = one(sp.status) === "resolved" ? "resolved" : one(sp.status) === "all" ? undefined : "open";
  const { staff } = await requireStaff("/escrow/reconciliation", "escrow.read");
  const rows = await safe("escrow.issues", () => listIssues({ status, limit: 100 }));
  const canManage = hasPrivilege(staff, "escrow.manage");
  return (
    <>
      <PageHeader title="Escrow reconciliation" description="Differences between the partner statement and our ledger. Nothing here moves money; resolve once the cause is understood." />
      <LinkTabs label="Status" items={[
        { href: "/escrow/reconciliation", label: "Open", active: status === "open" },
        { href: "/escrow/reconciliation?status=resolved", label: "Resolved", active: status === "resolved" },
        { href: "/escrow/reconciliation?status=all", label: "All", active: status === undefined },
      ]} />
      {canManage ? <RunReconciliationForm /> : null}
      <p className="text-sm"><Link href="/escrow" className="text-brand-700 underline">Back to escrows</Link></p>
      {rows === null ? <Alert tone="warning">Reconciliation data is currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No issues" description="Nothing matches this filter." /> : (
        <Table>
          <thead><tr><Th>Found</Th><Th>Kind</Th><Th>Escrow</Th><Th>Ledger</Th><Th>Partner</Th><Th>Detail</Th><Th>Status</Th>{canManage ? <Th>Resolve</Th> : null}</tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <Td className="whitespace-nowrap">{fmtDate(i.createdAt)}</Td>
                <Td>{i.kind.replace(/_/g, " ")}</Td>
                <Td>{i.escrowId ? <Link href={`/escrow/${i.escrowId}`} className="text-brand-700 underline"><Mono>{shortId(i.escrowId)}</Mono></Link> : "-"}</Td>
                <Td className="tabular-nums">{i.expectedPaise === null ? "-" : inr(i.expectedPaise)}</Td>
                <Td className="tabular-nums">{i.actualPaise === null ? "-" : inr(i.actualPaise)}</Td>
                <Td>{i.detail}{i.resolutionNote ? <span className="text-muted"> Resolved: {i.resolutionNote}</span> : null}</Td>
                <Td><Badge tone={i.status === "open" ? "danger" : "neutral"}>{i.status}</Badge></Td>
                {canManage ? <Td>{i.status === "open" ? <ResolveIssueForm issueId={i.id} /> : null}</Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
