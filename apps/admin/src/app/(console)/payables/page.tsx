import { listOverdueMsmePayables } from "@cnote/enquiry";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import { FilterActions, FilterBar, FilterField, FilterSelect } from "@/components/filters";
import { Mono, Table, Td, Th } from "@/components/table";
import { inr } from "@/features/payments/format";
import { requireStaff } from "@/lib/auth";
import { one, safe, shortId } from "@/lib/util";

// Due dates are Indian calendar dates (no time of day).
const fmtDate = (day: string) => new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-IN", { timeZone: "UTC", dateStyle: "medium" });

export const metadata = { title: "Overdue MSME payables" };
export const dynamic = "force-dynamic";

const MIN_DAYS = ["1", "8", "31", "91"] as const;

/** Read-only: no mutation here, so nothing goes through audited(). Needs payables.read. */
export default async function PayablesPage({ searchParams }: PageProps<"/payables">) {
  const sp = await searchParams;
  const minRaw = one(sp.min);
  const min = MIN_DAYS.find((m) => m === minRaw);
  await requireStaff(`/payables${min ? `?min=${min}` : ""}`, "payables.read");
  const data = await safe("payables.overdue", () => listOverdueMsmePayables({ limit: 200, minDaysOverdue: min ? Number(min) : 1 }));
  return (
    <>
      <PageHeader
        title="Overdue MSME payables"
        description="Open supplier invoices from sellers who declared themselves micro or small enterprises (Udyam on file) that are past the statutory due date: IT Act s.43B(h), MSMED Act s.15. Read-only; buyers pay and record payment themselves."
      />
      <FilterBar label="Filter overdue payables">
        <FilterField label="Overdue by" width="md">
          <FilterSelect name="min" defaultValue={min ?? "1"}>
            <option value="1">Any time</option>
            <option value="8">More than 7 days</option>
            <option value="31">More than 30 days</option>
            <option value="91">More than 90 days</option>
          </FilterSelect>
        </FilterField>
        <FilterActions submitLabel="Apply" clearHref={min ? "/payables" : undefined} />
      </FilterBar>
      {data === null ? (
        <Alert tone="warning">Payables are currently unavailable.</Alert>
      ) : data.items.length === 0 ? (
        <EmptyState title="Nothing overdue" description="No open MSME invoice is past its statutory due date." />
      ) : (
        <>
          <p className="text-sm text-muted" aria-live="polite">
            {data.totalOverdue} overdue invoice{data.totalOverdue === 1 ? "" : "s"}, {inr(data.totalOverduePaise)} outstanding in total.
          </p>
          <Table>
            <thead><tr><Th>Due</Th><Th>Overdue</Th><Th>Buyer</Th><Th>Seller</Th><Th>PO</Th><Th>Invoice</Th><Th>Outstanding</Th><Th>Basis</Th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <Td className="whitespace-nowrap">{i.due.dueDate ? fmtDate(i.due.dueDate) : "-"}</Td>
                  <Td><Badge tone="danger">{Math.abs(i.due.daysRemaining ?? 0)} days</Badge></Td>
                  <Td>{i.buyerName}</Td>
                  <Td>{i.sellerName}</Td>
                  <Td><Mono>{i.purchaseOrderNumber}</Mono></Td>
                  <Td><Mono>{i.invoiceNumber}</Mono><span className="block text-xs text-muted">{shortId(i.id)}</span></Td>
                  <Td className="tabular-nums">{inr(i.outstandingPaise)}</Td>
                  <Td className="text-xs">
                    {i.due.agreementBasis === "written_agreement" ? `Written agreement, ${i.due.statutoryDays} days` : "No written agreement, 15 days"}
                    <span className="block text-muted">from {i.due.dueBasis === "delivery" ? "delivery" : "invoice date"} {fmtDate(i.due.acceptanceDate)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {data.nextCursor ? <p className="text-xs text-muted">Showing the first 200, longest overdue first.</p> : null}
        </>
      )}
    </>
  );
}
