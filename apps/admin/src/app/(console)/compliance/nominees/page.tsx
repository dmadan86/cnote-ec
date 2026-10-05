import { listNomineeRequests, type NomineeRequestStatus } from "@cnote/compliance";
import { Alert, Badge, EmptyState, LinkTabs } from "@cnote/ui";
import Link from "next/link";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Nominee requests" };

const FILTERS = [{ key: "received", label: "To verify" }, { key: "verified", label: "Verified" }, { key: "completed", label: "Completed" }, { key: "rejected", label: "Rejected" }] as const;
const TONE = { received: "warning", verified: "brand", completed: "success", rejected: "danger" } as const;

/** DPDP s.14 nominee requests (a nominee asking to exercise a deceased or incapacitated principal's rights). The list holds no personal details. */
export default async function NomineeRequestsPage({ searchParams }: PageProps<"/compliance/nominees">) {
  const sp = await searchParams;
  const f = FILTERS.find((x) => x.key === one(sp.filter))?.key ?? "received";
  await requireStaff("/compliance/nominees", "compliance.manage");
  const items = await safe("compliance.listNomineeRequests", () => listNomineeRequests({ status: f as NomineeRequestStatus }));
  return (
    <>
      <LinkTabs label="Nominee request filter" items={FILTERS.map((x) => ({ href: x.key === "received" ? "/compliance/nominees" : `/compliance/nominees?filter=${x.key}`, label: x.label, active: x.key === f }))} />
      <Alert tone="info" className="mt-3">A nominee may act only if the account holder nominated them. Check the supporting documents (death certificate or guardianship order) offline before verifying. Answer within the due date (90 days for rights requests, DPDP Rules 2025).</Alert>
      {items === null ? <Alert tone="warning" className="mt-3">Nominee requests are currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing here" description="No nominee requests match this filter." /> : null}
      {items?.length ? (
        <Table>
          <thead><tr><Th>Filed</Th><Th>Ground</Th><Th>Matches a nomination</Th><Th>Due</Th><Th>Status</Th><Th><span className="sr-only">Open</span></Th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <Td>{fmtDate(r.createdAt)}</Td>
                <Td>{r.ground}</Td>
                <Td>{r.nomineeMatched ? <Badge tone="success">yes</Badge> : <Badge tone="danger">{r.principalFound ? "no" : "no account"}</Badge>}</Td>
                <Td>{fmtDate(r.dueAt)}{r.overdue ? <Badge tone="danger" className="ml-1">overdue</Badge> : null}</Td>
                <Td><Badge tone={TONE[r.status]}>{r.status}</Badge></Td>
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/compliance/nominees/${r.id}`}>Review <span className="sr-only">request {shortId(r.id)}</span></Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}
