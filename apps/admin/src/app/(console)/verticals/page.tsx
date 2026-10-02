import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, buttonClasses, EmptyState, PageHeader, type BadgeTone } from "@cnote/ui";
import { checklistProgress, listSnapshots, listVerticals } from "@cnote/verticals";
import Link from "next/link";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { safe } from "@/lib/util";

export const metadata = { title: "Verticals" };
const STAGE_TONE: Record<string, BadgeTone> = { candidate: "neutral", pilot: "warning", open: "success", paused: "danger" };

export default async function VerticalsPage() {
  const { staff } = await requireStaff("/verticals", "verticals.manage");
  const rows = await safe("verticals.list", async () =>
    Promise.all((await listVerticals()).map(async (v) => ({ v, progress: await checklistProgress(v.id), snap: (await listSnapshots(v.id, 3)).at(-1) ?? null }))),
  );
  return (
    <>
      <PageHeader
        title="Verticals"
        description="ADR-016: a new vertical may launch only when every open vertical has at least 200 verified sellers and positive net adds. Gate status is from the latest daily snapshot."
        actions={hasPrivilege(staff, "verticals.manage") ? <Link href="/verticals/new" className={buttonClasses("primary", "md", "shrink-0 whitespace-nowrap")}>New vertical</Link> : undefined}
      />
      {rows === null ? <Alert tone="warning">Verticals are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No verticals yet" description="Create a candidate from the playbook template." /> : (
        <Table>
          <thead><tr><Th>Vertical</Th><Th>Stage</Th><Th>Gates</Th><Th>Verified sellers</Th><Th>Net adds 30d / 90d</Th><Th>Checklist</Th></tr></thead>
          <tbody>
            {rows.map(({ v, progress, snap }) => (
              <tr key={v.id}>
                <Td><Link href={`/verticals/${v.id}`} className="font-medium text-brand-700 hover:underline">{v.name}</Link><div className="text-xs text-muted">{v.categorySlugs.join(", ")}</div></Td>
                <Td><Badge tone={STAGE_TONE[v.stage] ?? "neutral"}>{v.stage}</Badge></Td>
                <Td>{snap ? <Badge tone={snap.meetsGates ? "success" : "warning"}>{snap.meetsGates ? "gates met" : "gates not met"}</Badge> : <Badge tone="neutral">no snapshot</Badge>}</Td>
                <Td>{snap ? `${snap.verifiedSellers} / ${v.gates.minVerifiedSellers}` : "-"}</Td>
                <Td>{snap ? `${snap.netAdds30 ?? "n/a"} / ${snap.netAdds90 ?? "n/a"}` : "-"}</Td>
                <Td>{progress.done} / {progress.total}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
