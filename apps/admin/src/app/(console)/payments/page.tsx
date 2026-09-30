import { listPaymentOrders } from "@cnote/billing";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { inr } from "@/features/payments/format";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

const STATUSES = ["created", "pending", "paid", "failed", "refunded", "partially_refunded"] as const;
const PURPOSES = ["subscription", "credit_pack", "ad_topup"] as const;
const TONE: Record<string, BadgeTone> = { paid: "success", failed: "danger", pending: "warning", created: "neutral", refunded: "brand", partially_refunded: "brand" };

export default async function PaymentsPage({ searchParams }: PageProps<"/payments">) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === one(sp.status));
  const purpose = PURPOSES.find((s) => s === one(sp.purpose));
  const businessId = one(sp.business);
  await requireStaff("/payments", "payments.read");
  const rows = await safe("payments.list", () => listPaymentOrders({ status, purpose, businessId: businessId && /^[0-9a-f-]{36}$/i.test(businessId) ? businessId : undefined, limit: 100 }));
  const q = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ status, purpose, business: businessId, ...o }).filter(([, v]) => v) as [string, string][]);
    return `/payments${p.size ? `?${p}` : ""}`;
  };
  return (
    <>
      <PageHeader title="Payments" description="Gateway orders for plans, credit packs and ad top-ups. Fulfilment happens on the provider webhook." />
      <LinkTabs label="Status" items={[{ href: q({ status: undefined }), label: "All", active: !status }, ...STATUSES.map((s) => ({ href: q({ status: s }), label: s.replace("_", " "), active: s === status }))]} />
      <LinkTabs label="Purpose" items={[{ href: q({ purpose: undefined }), label: "Any purpose", active: !purpose }, ...PURPOSES.map((s) => ({ href: q({ purpose: s }), label: s.replace("_", " "), active: s === purpose }))]} />
      <p className="text-sm"><Link href="/payments/invoices" className="text-brand-700 underline">Invoices and credit notes</Link></p>
      {rows === null ? <Alert tone="warning">Payments are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No payments" description="Nothing matches this filter." /> : (
        <Table>
          <thead><tr><Th>Order</Th><Th>Created</Th><Th>Business</Th><Th>Purpose</Th><Th>Provider</Th><Th>Total</Th><Th>Refunded</Th><Th>Status</Th></tr></thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <Td><Link href={`/payments/${o.id}`} className="text-brand-700 underline"><Mono>{shortId(o.id)}</Mono></Link></Td>
                <Td className="whitespace-nowrap">{fmtDate(o.createdAt)}</Td>
                <Td><Link href={`/businesses/${o.businessId}`}><Mono>{shortId(o.businessId)}</Mono></Link></Td>
                <Td>{o.purpose.replace("_", " ")}{o.purposeRef ? <span className="text-muted"> ({o.purposeRef.split("|")[0]})</span> : null}</Td>
                <Td>{o.provider}</Td>
                <Td className="tabular-nums">{inr(o.totalPaise)}</Td>
                <Td className="tabular-nums">{o.refundedPaise ? inr(o.refundedPaise) : "-"}</Td>
                <Td><Badge tone={TONE[o.status] ?? "neutral"}>{o.status.replace("_", " ")}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
