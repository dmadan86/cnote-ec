import { disputesEnabled, getDispute, SLA_DAYS } from "@/lib/disputes";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardTitle, Container, Money, PageHeader, type BadgeTone } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IntentButton, RespondForm, TextForm } from "@/features/disputes/forms";
import { disputeLabels, fill } from "@/features/disputes/labels";

export const metadata: Metadata = { title: "Dispute" };
export const dynamic = "force-dynamic";
const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const TONE: Record<string, BadgeTone> = { resolved: "success", withdrawn: "neutral", awaiting_adjudication: "warning", auto_resolved: "warning", open: "brand", evidence: "brand", brief_ready: "brand" };

export default async function BuyerDisputePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/disputes/${id}`);
  if (!disputesEnabled()) notFound();
  const [d, l] = await Promise.all([getDispute(actorOf(s), id), disputeLabels()]);
  if (!d) notFound();
  const who = (e: { party: string; mine: boolean }) => (e.party === "system" ? l.fromSystem : e.mine ? l.fromYou : l.fromOther);
  const active = !["resolved", "withdrawn"].includes(d.status);
  return (
    <Container className="max-w-3xl py-8">
      <Link href={`/buyer/orders/${d.orderId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{l.backToOrder}</Link>
      <PageHeader
        title={`${l.heading}: ${l[`type_${d.type}` as keyof typeof l]}`}
        description={active ? fill(l.dueBy, { date: dt.format(new Date(d.dueAt)) }) : undefined}
        actions={<Badge tone={TONE[d.status] ?? "neutral"}>{l[`status_${d.status}` as keyof typeof l]}</Badge>}
      />
      <div className="mt-6 flex flex-col gap-6">
        {d.can.respond ? <Alert tone="warning">{fill(l.responseBy, { date: dt.format(new Date(d.responseDueAt)) })}</Alert> : null}
        {d.proposal ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{l.proposalTitle}</CardTitle>
            <p className="text-sm text-ink">{fill(l.proposalBody, { date: dt.format(new Date(d.proposal.escalationDeadline)) })}</p>
            <Outcome outcome={d.proposal.outcome} refund={d.proposal.refundPaise} release={d.proposal.releasePaise} l={l} />
            {d.can.escalate ? <IntentButton disputeId={d.id} intent="escalate" label={l.escalate} /> : null}
          </CardBody></Card>
        ) : null}
        {d.decision ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{l.decisionTitle}</CardTitle>
            <Outcome outcome={d.decision.outcome} refund={d.decision.refundPaise} release={d.decision.releasePaise} l={l} />
            <p className="text-sm text-muted">{d.decision.decidedBy === "auto" ? l.decidedAuto : l.decidedStaff}</p>
            <p className="text-sm text-ink">{d.decision.rationale}</p>
          </CardBody></Card>
        ) : null}
        <Card><CardBody className="flex flex-col gap-3">
          <CardTitle>{l.evidenceTitle}</CardTitle>
          {d.evidence.length === 0 ? <p className="text-sm text-muted">{l.noEvidence}</p> : (
            <ul className="flex flex-col gap-3">
              {d.evidence.map((e) => (
                <li key={e.id} className="rounded-card border border-border p-3 text-sm">
                  <p className="text-xs text-muted">{who(e)} · {dt.format(new Date(e.createdAt))}</p>
                  {e.text ? <p className="mt-1 whitespace-pre-wrap text-ink">{e.text}</p> : null}
                  {e.hasFile && !e.purged ? <a className="mt-1 inline-flex min-h-11 items-center font-medium text-brand-700 underline" href={`/buyer/disputes/${d.id}/evidence/${e.id}`}>{e.kind} ({e.mimeType})</a> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody></Card>
        {d.can.respond || d.can.addEvidence ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{d.can.respond ? l.respondTitle : l.addEvidenceTitle}</CardTitle>
            <RespondForm disputeId={d.id} labels={l} respond={d.can.respond} />
          </CardBody></Card>
        ) : null}
        {d.can.appeal ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{l.appealFormTitle}</CardTitle>
            <p className="text-sm text-muted">{l.appealBody}</p>
            <TextForm disputeId={d.id} intent="appeal" label={l.appealReasonLabel} submit={l.appealSubmit} sent={l.appealSent} labels={l} />
          </CardBody></Card>
        ) : d.appeal ? <Alert tone="info">{l.appealSent}</Alert> : null}
        <Card><CardBody className="flex flex-col gap-3">
          <CardTitle>{l.messagesTitle}</CardTitle>
          <ul className="flex flex-col gap-2">
            {d.messages.map((m) => <li key={m.id} className="rounded-card bg-surface p-3 text-sm"><span className="text-xs text-muted">{m.mine ? l.fromYou : "Cnote"} · {dt.format(new Date(m.createdAt))}</span><br />{m.body}</li>)}
          </ul>
          <TextForm disputeId={d.id} intent="message" label={l.messageLabel} submit={l.send} labels={l} />
        </CardBody></Card>
        {d.can.withdraw ? <div><IntentButton disputeId={d.id} intent="withdraw" label={l.withdraw} /></div> : null}
        <p className="text-xs text-muted">SLA: {SLA_DAYS} days · <Link href="/dispute-policy" className="underline">{l.policyLink}</Link></p>
      </div>
    </Container>
  );
}

function Outcome({ outcome, refund, release, l }: { outcome: string; refund: number; release: number; l: Record<string, string> }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-3">
      <div><dt className="text-xs text-muted">{l.decisionTitle}</dt><dd className="font-medium text-ink">{l[`outcome_${outcome}`]}</dd></div>
      <div><dt className="text-xs text-muted">{l.refundLabel}</dt><dd><Money paise={refund} /></dd></div>
      <div><dt className="text-xs text-muted">{l.releaseLabel}</dt><dd><Money paise={release} /></dd></div>
    </dl>
  );
}
