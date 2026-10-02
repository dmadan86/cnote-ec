import { getPaymentOrderDetail } from "@cnote/billing";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mono, Table, Td, Th } from "@/components/table";
import { RefundForm } from "@/features/payments/refund-form";
import { requireStaff } from "@/lib/auth";
import { inr } from "@/features/payments/format";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Payment" };
export const dynamic = "force-dynamic";

export default async function PaymentDetailPage({ params }: PageProps<"/payments/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { staff } = await requireStaff(`/payments/${id}`, "payments.read");
  const d = await safe("payments.detail", () => getPaymentOrderDetail(id));
  if (!d) notFound();
  const o = d.order;
  const refundable = o.status === "paid" || o.status === "partially_refunded" ? o.totalPaise - o.refundedPaise : 0;
  return (
    <>
      <PageHeader title={`Payment ${id.slice(0, 8)}`} description={`${o.purpose.replace("_", " ")} via ${o.provider}`} />
      <Card>
        <CardBody className="grid gap-2 text-sm sm:grid-cols-2">
          <p>Status: <Badge tone={o.status === "paid" ? "success" : o.status === "failed" ? "danger" : "neutral"}>{o.status.replace("_", " ")}</Badge></p>
          <p>Business: <Link href={`/businesses/${o.businessId}`} className="font-medium text-brand-700 hover:underline"><Mono>{o.businessId}</Mono></Link></p>
          <p>Taxable: {inr(o.amountPaise)} · GST: {inr(o.gstPaise)} · Total: <strong>{inr(o.totalPaise)}</strong></p>
          <p>Discount: {o.discountPaise ? inr(o.discountPaise) : "none"}{o.couponCode ? ` (${o.couponCode})` : ""}</p>
          <p>Provider order: <Mono>{d.providerOrderId ?? "-"}</Mono></p>
          <p>Provider payment: <Mono>{d.providerPaymentId ?? "-"}</Mono></p>
          <p>Created: {fmtDate(o.createdAt)} · Fulfilled: {o.fulfilledAt ? fmtDate(o.fulfilledAt) : "no"}</p>
          {o.failureReason ? <p>Failure: {o.failureReason}</p> : null}
          {o.invoiceId ? <p><a className="font-medium text-brand-700 hover:underline" href={`/payments/invoices/${o.invoiceId}/pdf`}>Tax invoice PDF</a></p> : null}
        </CardBody>
      </Card>
      {hasPrivilege(staff, "payments.refund") ? (
        <Card>
          <CardHeader><CardTitle>Refund</CardTitle></CardHeader>
          <CardBody>
            {refundable > 0 ? <RefundForm orderId={id} maxRupees={refundable / 100} /> : <Alert tone="info">Nothing left to refund.</Alert>}
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Refunds</CardTitle></CardHeader>
        <CardBody>
          {d.refunds.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <Table><thead><tr><Th>When</Th><Th>Amount</Th><Th>Status</Th><Th>Reason</Th><Th>Credit note</Th></tr></thead><tbody>
              {d.refunds.map((r) => (
                <tr key={r.id}><Td>{fmtDate(r.createdAt)}</Td><Td className="tabular-nums">{inr(r.amountPaise)}</Td><Td>{r.status}</Td><Td>{r.reason}</Td>
                  <Td>{r.creditNoteId ? <a className="font-medium text-brand-700 hover:underline" href={`/payments/invoices/${r.creditNoteId}/pdf`}>PDF</a> : "-"}</Td></tr>
              ))}
            </tbody></Table>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Webhook log</CardTitle></CardHeader>
        <CardBody>
          {d.events.length === 0 ? <p className="text-sm text-muted">No webhooks received for this order.</p> : (
            <Table><thead><tr><Th>Received</Th><Th>Type</Th><Th>Event id</Th><Th>Processed</Th><Th>Error</Th></tr></thead><tbody>
              {d.events.map((e) => (
                <tr key={e.id}><Td className="whitespace-nowrap">{fmtDate(e.receivedAt)}</Td><Td>{e.type}</Td><Td><Mono>{e.eventId}</Mono></Td><Td>{e.processedAt ? fmtDate(e.processedAt) : "no"}</Td><Td>{e.error ?? "-"}</Td></tr>
              ))}
            </tbody></Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}
