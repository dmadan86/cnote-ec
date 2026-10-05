import { audited } from "@cnote/admin";
import { getNomineeRequest } from "@cnote/compliance";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle } from "@cnote/ui";
import { notFound } from "next/navigation";
import { NomineeCompleteForm, NomineeDecisionForm } from "@/features/compliance/forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, shortId } from "@/lib/util";

export const metadata = { title: "Nominee request" };

export default async function NomineeRequestPage({ params }: PageProps<"/compliance/nominees/[id]">) {
  const { id } = await params;
  const { ctx } = await requireStaff(`/compliance/nominees/${id}`, "compliance.manage");
  // Decrypts the requester's name, contact and message and the principal's registered nominees: a privileged read, so it is audited.
  const r = await audited(ctx, "compliance.manage", "nominee_request.view", { type: "NomineeRequest", id }, () => getNomineeRequest(id));
  if (!r) notFound();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Nominee request <code>{shortId(r.id)}</code> · filed {fmtDate(r.createdAt)} · due {fmtDate(r.dueAt)} <Badge>{r.status}</Badge> {r.overdue ? <Badge tone="danger">overdue</Badge> : null}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>The request</CardTitle></CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p><strong>Requester:</strong> {r.requesterName} · {r.requesterContact}</p>
            <p><strong>Ground:</strong> {r.ground}</p>
            <p className="whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3">{r.message}</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>The account holder</CardTitle></CardHeader>
          <CardBody className="space-y-2 text-sm">
            {r.principal ? (
              <>
                <p><strong>Account:</strong> {r.principal.emailMasked ?? "no email"} · created {fmtDate(r.principal.createdAt)}{r.principal.lastActiveAt ? ` · last active ${fmtDate(r.principal.lastActiveAt)}` : ""}</p>
                {r.principal.erased ? <Alert tone="warning">This account was already erased.</Alert> : null}
                <p><strong>Registered nominees:</strong></p>
                {r.registeredNominees.length ? (
                  <ul className="list-disc pl-5">
                    {r.registeredNominees.map((n, i) => (
                      <li key={i}>{n.name} ({n.relationship.replace("_", " ")}) {n.contactMatches ? <Badge tone="success">contact matches the requester</Badge> : <Badge>different contact</Badge>}</li>
                    ))}
                  </ul>
                ) : <p className="text-muted">None.</p>}
              </>
            ) : <Alert tone="warning">No account matches the e-mail address given.</Alert>}
            {!r.nomineeMatched ? <Alert tone="danger">The requester does not match an active nomination. This request can only be rejected.</Alert> : null}
          </CardBody>
        </Card>
      </div>
      {r.reviewNote ? <Alert tone="info"><strong>Review note:</strong> {r.reviewNote}</Alert> : null}
      {r.actionTaken ? <Alert tone="success"><strong>Action taken:</strong> {r.actionTaken.replace("_", " ")} — {r.actionNote}</Alert> : null}
      {r.status === "received" ? <Card><CardHeader><CardTitle>Decision</CardTitle></CardHeader><CardBody><NomineeDecisionForm id={r.id} canVerify={r.nomineeMatched} /></CardBody></Card> : null}
      {r.status === "verified" ? <Card><CardHeader><CardTitle>Complete</CardTitle></CardHeader><CardBody><NomineeCompleteForm id={r.id} /></CardBody></Card> : null}
    </div>
  );
}
