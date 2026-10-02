import { listInvoices } from "@cnote/billing";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { inr } from "@/features/payments/format";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: PageProps<"/payments/invoices">) {
  const sp = await searchParams;
  const b = one(sp.business);
  await requireStaff("/payments/invoices", "payments.read");
  const rows = await safe("invoices.list", () => listInvoices({ staff: true }, { businessId: b && /^[0-9a-f-]{36}$/i.test(b) ? b : undefined, limit: 200 }));
  return (
    <>
      <PageHeader title="Invoices" description="GST tax invoices and credit notes, newest first." />
      <p className="text-sm"><Link href="/payments" className="font-medium text-brand-700 hover:underline">Back to payments</Link></p>
      {rows === null ? <Alert tone="warning">Invoices are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No invoices" description="Nothing issued yet." /> : (
        <Table>
          <thead><tr><Th>Number</Th><Th>Type</Th><Th>Issued</Th><Th>Business</Th><Th>Taxable</Th><Th>GST</Th><Th>Total</Th><Th /></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <Td><Mono>{i.number}</Mono></Td>
                <Td><Badge tone={i.kind === "credit_note" ? "warning" : "success"}>{i.kind.replace("_", " ")}</Badge></Td>
                <Td className="whitespace-nowrap">{fmtDate(i.issuedAt)}</Td>
                <Td><Mono>{shortId(i.businessId)}</Mono></Td>
                <Td className="tabular-nums">{inr(i.taxablePaise)}</Td>
                <Td className="tabular-nums">{inr(i.gstPaise)}</Td>
                <Td className="tabular-nums">{inr(i.totalPaise)}</Td>
                <Td><a className="font-medium text-brand-700 hover:underline" href={`/payments/invoices/${i.id}/pdf`}>PDF</a></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
