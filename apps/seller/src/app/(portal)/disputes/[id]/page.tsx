import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { actorOf } from "@cnote/next-kit";
import { disputesEnabled, getDispute } from "@/lib/disputes";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { EvidenceForm, IntentButton, TextForm } from "@/features/disputes/forms";

export const metadata: Metadata = { title: "Dispute" };
export const dynamic = "force-dynamic";
const label = (s: string) => s.replace(/_/g, " ");
const OUTCOME: Record<string, string> = { buyer_favour: "In favour of the buyer", seller_favour: "In favour of the seller", split: "Split between both sides", withdrawn: "Withdrawn" };

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/disputes/${id}`);
  const back = <Link href="/disputes" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft className="size-4" aria-hidden /> Back to disputes</Link>;
  if (!disputesEnabled()) return <div className="space-y-4">{back}<Alert tone="info">Dispute resolution is not available yet.</Alert></div>;
  const res = await load(() => getDispute(actorOf(session), id));
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const d = res.data;
  if (!d) return <div className="space-y-4">{back}<Alert tone="warning">We could not find this dispute.</Alert></div>;
  const active = !["resolved", "withdrawn"].includes(d.status);
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={`Dispute: ${label(d.type)}`} description={active ? `Decision due by ${formatDateTime(d.dueAt)}` : undefined} actions={<Badge tone="brand">{label(d.status)}</Badge>} />
      {d.can.respond ? <Alert tone="warning">Please respond by {formatDateTime(d.responseDueAt)}. If you do not, the case is reviewed with the evidence on file.</Alert> : null}
      <Card>
        <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-sm">
          <p className="whitespace-pre-wrap text-ink">{d.description}</p>
          <p className="text-muted">{d.amountPaise !== null ? <>Claimed <Money paise={d.amountPaise} /> · </> : null}Amount held <Money paise={d.atStakePaise} /></p>
        </CardBody>
      </Card>
      {d.proposal ? (
        <Card>
          <CardHeader><CardTitle>Proposed automatic decision</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p>{OUTCOME[d.proposal.outcome]}: refund to buyer <Money paise={d.proposal.refundPaise} />, release to you <Money paise={d.proposal.releasePaise} />. It applies on {formatDateTime(d.proposal.escalationDeadline)} unless either side asks for a person to decide.</p>
            {d.can.escalate ? <IntentButton disputeId={d.id} intent="escalate" label="Ask a person to decide" /> : null}
          </CardBody>
        </Card>
      ) : null}
      {d.decision ? (
        <Card>
          <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p className="font-medium text-ink">{OUTCOME[d.decision.outcome]} ({d.decision.decidedBy === "auto" ? "decided automatically" : "decided by an adjudicator"})</p>
            <p>Refund to buyer <Money paise={d.decision.refundPaise} /> · Released to you <Money paise={d.decision.releasePaise} /></p>
            <p className="text-muted">{d.decision.rationale}</p>
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Evidence</CardTitle></CardHeader>
        <CardBody>
          {d.evidence.length === 0 ? <p className="text-sm text-muted">No evidence yet.</p> : (
            <ul className="space-y-3">
              {d.evidence.map((e) => (
                <li key={e.id} className="rounded-card border border-border p-3 text-sm">
                  <p className="text-xs text-muted">{e.party === "system" ? "Recorded automatically" : e.mine ? "You" : "Buyer"} · {formatDateTime(e.createdAt)}</p>
                  {e.text ? <p className="mt-1 whitespace-pre-wrap text-ink">{e.text}</p> : null}
                  {e.hasFile && !e.purged ? <a className="mt-1 inline-flex min-h-11 items-center font-medium text-brand-700 underline" href={`/disputes/${d.id}/evidence/${e.id}`}>{e.kind} ({e.mimeType})</a> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {d.can.respond || d.can.addEvidence ? (
        <Card><CardHeader><CardTitle>{d.can.respond ? "Respond to this dispute" : "Add evidence"}</CardTitle></CardHeader><CardBody><EvidenceForm disputeId={d.id} respond={d.can.respond} /></CardBody></Card>
      ) : null}
      {d.can.appeal ? (
        <Card><CardHeader><CardTitle>Appeal this decision</CardTitle></CardHeader><CardBody><TextForm disputeId={d.id} intent="appeal" label="Why do you disagree?" submit="Submit appeal" /></CardBody></Card>
      ) : d.appeal ? <Alert tone="info">Your appeal ({d.appeal.status}) {d.appeal.resolutionNote ? `: ${d.appeal.resolutionNote}` : "has been received."}</Alert> : null}
      <Card>
        <CardHeader><CardTitle>Messages with our team</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <ul className="space-y-2">{d.messages.map((m) => <li key={m.id} className="rounded-card bg-surface p-3 text-sm"><span className="text-xs text-muted">{m.mine ? "You" : "Cnote"} · {formatDateTime(m.createdAt)}</span><br />{m.body}</li>)}</ul>
          <TextForm disputeId={d.id} intent="message" label="Write a message" submit="Send" />
        </CardBody>
      </Card>
      {d.can.withdraw ? <IntentButton disputeId={d.id} intent="withdraw" label="Withdraw dispute" /> : null}
    </div>
  );
}
