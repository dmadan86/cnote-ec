import { hasPrivilege } from "@cnote/admin";
import { listGrievances, type GrievanceStatus, type GrievanceView } from "@cnote/compliance";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs } from "@cnote/ui";
import { GrievanceResponseForm } from "@/features/compliance/forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Grievances" };

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "breached", label: "SLA breached" },
  { key: "resolved", label: "Resolved" },
  { key: "rejected", label: "Closed without action" },
] as const;

const slaBadge = (g: GrievanceView) => {
  const out: React.ReactNode[] = [];
  if (g.sla.acknowledgement === "breached") out.push(<Badge key="a" tone="danger">Acknowledgement overdue</Badge>);
  if (g.sla.resolution === "breached") out.push(<Badge key="r" tone="danger">Resolution overdue</Badge>);
  else if (g.sla.resolution === "due_soon") out.push(<Badge key="d" tone="warning">Due within 3 days</Badge>);
  else if (g.sla.resolution === "on_track" && g.sla.acknowledgement !== "breached") out.push(<Badge key="o" tone="success">On track</Badge>);
  return out;
};

export default async function GrievancesPage({ searchParams }: PageProps<"/compliance">) {
  const sp = await searchParams;
  const f = FILTERS.find((x) => x.key === one(sp.filter))?.key ?? "open";
  const { staff } = await requireStaff("/compliance", "compliance.read");
  const canManage = hasPrivilege(staff, "compliance.manage");
  const items = await safe("compliance.listGrievances", () => listGrievances(f === "breached" ? { breachedOnly: true } : { status: f as GrievanceStatus }));

  return (
    <>
      <LinkTabs label="Grievance filter" items={FILTERS.map((x) => ({ href: x.key === "open" ? "/compliance" : `/compliance?filter=${x.key}`, label: x.label, active: x.key === f }))} />
      {!canManage ? <Alert tone="info">You can view grievances but your role can&apos;t respond to them.</Alert> : null}
      {items === null ? <Alert tone="warning">Grievances are currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing here" description="No grievances match this filter." /> : null}
      <ul className="space-y-4">
        {items?.map((g) => (
          <li key={g.id}>
            <Card>
              <CardBody className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand">{g.category}</Badge>
                  <Badge>{g.status.replace("_", " ")}</Badge>
                  {slaBadge(g)}
                </div>
                <h2 className="text-base font-semibold text-ink">{g.subject}</h2>
                <p className="text-xs text-muted">
                  Ticket <code>{shortId(g.id)}</code> · filed {fmtDate(g.createdAt)} · due {fmtDate(g.dueAt)} · {g.personId ? `person ${shortId(g.personId)}` : `contact ${g.contactEmail ?? "n/a"}`}
                </p>
                <p className="whitespace-pre-wrap">{g.body}</p>
                {g.resolution ? <p className="rounded-lg border border-line bg-canvas p-3"><strong>Resolution:</strong> {g.resolution}</p> : null}
                {canManage && (g.status === "open" || g.status === "in_progress") ? (
                  <details><summary className="cursor-pointer font-medium text-brand-700">Respond</summary><div className="mt-3"><GrievanceResponseForm id={g.id} /></div></details>
                ) : null}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
