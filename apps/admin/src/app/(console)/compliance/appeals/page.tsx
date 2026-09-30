import { listAppeals, type AppealStatus } from "@cnote/compliance";
import { Alert, Badge, EmptyState, LinkTabs } from "@cnote/ui";
import Link from "next/link";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Appeals" };

const FILTERS = [{ key: "open", label: "Open" }, { key: "resolved", label: "Upheld" }, { key: "rejected", label: "Rejected" }] as const;

export default async function AppealsPage({ searchParams }: PageProps<"/compliance/appeals">) {
  const sp = await searchParams;
  const f = FILTERS.find((x) => x.key === one(sp.filter))?.key ?? "open";
  await requireStaff("/compliance/appeals", "compliance.read");
  const items = await safe("compliance.listAppeals", () => listAppeals({ status: f as AppealStatus }));
  return (
    <>
      <LinkTabs label="Appeal filter" items={FILTERS.map((x) => ({ href: x.key === "open" ? "/compliance/appeals" : `/compliance/appeals?filter=${x.key}`, label: x.label, active: x.key === f }))} />
      {items === null ? <Alert tone="warning">Appeals are currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing here" description="No appeals match this filter." /> : null}
      {items?.length ? (
        <Table>
          <thead><tr><Th>Filed</Th><Th>Type</Th><Th>Reason</Th><Th>Status</Th><Th><span className="sr-only">Open</span></Th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <Td>{fmtDate(a.createdAt)}</Td>
                <Td>{a.subjectType.replace("_", " ")}</Td>
                <Td className="max-w-md"><span className="line-clamp-2">{a.reason}</span></Td>
                <Td><Badge tone={a.status === "resolved" ? "success" : a.status === "rejected" ? "danger" : "neutral"}>{a.status}</Badge>{a.needsFollowUp ? <Badge tone="warning" className="ml-1">follow-up</Badge> : null}</Td>
                <Td><Link className="text-brand-700 underline" href={`/compliance/appeals/${a.id}`}>Review <span className="sr-only">appeal {shortId(a.id)}</span></Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}
