import { getEscrowDetail, listIssues, listJournals } from "@cnote/escrow";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mono, Table, Td, Th } from "@/components/table";
import { MoveForm } from "@/features/escrow/forms";
import { inr } from "@/features/payments/format";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Escrow" };
export const dynamic = "force-dynamic";

export default async function EscrowDetailPage({ params }: PageProps<"/escrow/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { staff } = await requireStaff(`/escrow/${id}`, "escrow.read");
  const d = await safe("escrow.detail", () => getEscrowDetail(id));
  if (!d) notFound();
  const [journals, issues] = await Promise.all([safe("escrow.journals", () => listJournals(id)), safe("escrow.issues", () => listIssues({ escrowId: id }))]);
  const canManage = hasPrivilege(staff, "escrow.manage");
  return (
    <>
      <PageHeader title={`Escrow ${id.slice(0, 8)}`} description={`Order ${d.orderId.slice(0, 8)} via ${d.partner}`} />
      <Card>
        <CardBody className="grid gap-2 text-sm sm:grid-cols-2">
          <p>Status: <Badge tone="brand">{d.status.replace("_", " ")}</Badge>{d.frozen ? <> <Badge tone="danger">frozen by dispute</Badge></> : null}</p>
          <p>Partner reference: <Mono>{d.partnerRef ?? "-"}</Mono></p>
          <p>Buyer: <Link href={`/businesses/${d.buyerBusinessId}`} className="text-brand-700 underline"><Mono>{d.buyerBusinessId}</Mono></Link></p>
          <p>Seller: <Link href={`/businesses/${d.sellerBusinessId}`} className="text-brand-700 underline"><Mono>{d.sellerBusinessId}</Mono></Link></p>
          <p>Amount: <strong>{inr(d.amountPaise)}</strong> · Held now: <strong>{inr(d.heldPaise)}</strong></p>
          <p>Released: {inr(d.releasedPaise)} · Refunded: {inr(d.refundedPaise)}</p>
          <p>Fee target: {inr(d.feePaise)} · Fee charged: {inr(d.feeChargedPaise)}</p>
          <p>Created: {fmtDate(d.createdAt)}</p>
          {d.feeInvoiceId ? <p><a className="text-brand-700 underline" href={`/payments/invoices/${d.feeInvoiceId}/pdf`}>Fee tax invoice PDF</a></p> : null}
        </CardBody>
      </Card>
      {canManage ? (
        <Card>
          <CardHeader><CardTitle>Manual release / refund</CardTitle></CardHeader>
          <CardBody className="space-y-4">
            {d.frozen ? <Alert tone="warning">A dispute is open. Money can only move through the dispute decision.</Alert>
              : d.heldPaise <= 0 ? <Alert tone="info">No funds are held for this escrow.</Alert>
              : <><MoveForm escrowId={id} kind="release" /><MoveForm escrowId={id} kind="refund" /></>}
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Milestones</CardTitle></CardHeader>
        <CardBody>
          <Table><thead><tr><Th>When</Th><Th>Milestone</Th><Th>Source</Th></tr></thead><tbody>
            {d.milestones.map((m) => <tr key={m.milestone}><Td className="whitespace-nowrap">{fmtDate(m.at)}</Td><Td>{m.milestone}</Td><Td>{m.source}</Td></tr>)}
          </tbody></Table>
          {d.freezes.length > 0 ? <p className="mt-3 text-sm">Disputes: {d.freezes.map((f) => `${f.disputeId.slice(0, 8)} (${f.resolvedAt ? "resolved" : "open"})`).join(", ")}</p> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Transfers</CardTitle></CardHeader>
        <CardBody>
          {d.payouts.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
            <Table><thead><tr><Th>Requested</Th><Th>Kind</Th><Th>Amount</Th><Th>Status</Th><Th>Attempts</Th><Th>Settled</Th><Th>Latency</Th><Th>Error</Th></tr></thead><tbody>
              {d.payouts.map((p) => (
                <tr key={p.id}><Td className="whitespace-nowrap">{fmtDate(p.requestedAt)}</Td><Td>{p.kind.replace("_", " ")}</Td><Td className="tabular-nums">{inr(p.amountPaise)}</Td><Td>{p.status}</Td><Td>{p.attempts}</Td>
                  <Td>{p.settledAt ? fmtDate(p.settledAt) : "-"}</Td><Td>{p.latencyMs === null ? "-" : `${Math.round(p.latencyMs / 60_000)} min`}</Td><Td>{p.lastError ?? "-"}</Td></tr>
              ))}
            </tbody></Table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Ledger journal</CardTitle></CardHeader>
        <CardBody>
          {journals === null || journals.length === 0 ? <p className="text-sm text-muted">No journals.</p> : (
            <Table><thead><tr><Th>When</Th><Th>Kind</Th><Th>Account</Th><Th>Debit</Th><Th>Credit</Th><Th>Memo</Th></tr></thead><tbody>
              {journals.flatMap((j) => j.lines.map((l, i) => (
                <tr key={`${j.id}-${i}`}>
                  <Td className="whitespace-nowrap">{i === 0 ? fmtDate(j.createdAt) : ""}</Td><Td>{i === 0 ? j.kind : ""}</Td><Td><Mono>{l.account}</Mono></Td>
                  <Td className="tabular-nums">{l.debitPaise ? inr(l.debitPaise) : ""}</Td><Td className="tabular-nums">{l.creditPaise ? inr(l.creditPaise) : ""}</Td><Td>{i === 0 ? j.memo : ""}</Td>
                </tr>
              )))}
            </tbody></Table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Reconciliation issues</CardTitle></CardHeader>
        <CardBody>
          {issues === null || issues.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <ul className="space-y-1 text-sm">{issues.map((i) => <li key={i.id}><Badge tone={i.status === "open" ? "danger" : "neutral"}>{i.status}</Badge> {i.kind.replace(/_/g, " ")}: {i.detail}</li>)}</ul>
          )}
          <p className="mt-2 text-sm"><Link href="/escrow/reconciliation" className="text-brand-700 underline">All reconciliation issues</Link></p>
        </CardBody>
      </Card>
    </>
  );
}
