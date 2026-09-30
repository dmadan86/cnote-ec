import { hasPrivilege } from "@cnote/admin";
import { getAppealDetail } from "@cnote/compliance";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle } from "@cnote/ui";
import { notFound } from "next/navigation";
import { AppealDecisionForm } from "@/features/compliance/forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe, shortId } from "@/lib/util";

export const metadata = { title: "Appeal" };

export default async function AppealPage({ params }: PageProps<"/compliance/appeals/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/compliance/appeals/${id}`, "compliance.read");
  const canManage = hasPrivilege(staff, "compliance.manage");
  const detail = await safe("compliance.getAppealDetail", () => getAppealDetail(id));
  if (!detail) notFound();
  const { appeal, subject } = detail;
  const open = appeal.status === "open" || appeal.status === "in_progress";
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Appeal <code>{shortId(appeal.id)}</code> · filed {fmtDate(appeal.createdAt)} · <Badge>{appeal.status}</Badge></p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Original decision</CardTitle></CardHeader>
          <CardBody className="space-y-2 text-sm">
            {subject ? (
              <>
                <p className="font-semibold">{subject.title} <span className="font-normal text-muted">({subject.type.replace("_", " ")})</span></p>
                <p>Current status in the owning module: <Badge tone={subject.rejected ? "danger" : "success"}>{subject.status}</Badge></p>
                <p><strong>Reason given to the owner:</strong> {subject.moderationNote ?? "none recorded"}</p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-xs">{subject.content}</pre>
              </>
            ) : <Alert tone="warning">The original item is no longer available.</Alert>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>The appeal</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p className="whitespace-pre-wrap">{appeal.reason}</p>
            {appeal.decisionNote ? <p className="rounded-lg border border-line bg-canvas p-3"><strong>Decision note:</strong> {appeal.decisionNote}</p> : null}
            {open && subject && !subject.rejected ? <Alert tone="info">This item is no longer rejected. Upholding will not change it.</Alert> : null}
            {["listing_version", "storefront_version"].includes(appeal.subjectType) ? <Alert tone="info">Upholding an appeal on a version cannot re-approve it automatically. The seller is asked to resubmit and staff should fast-track that review.</Alert> : null}
            {open && canManage ? <AppealDecisionForm id={appeal.id} /> : null}
            {open && !canManage ? <Alert tone="info">Your role can&apos;t decide appeals.</Alert> : null}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
