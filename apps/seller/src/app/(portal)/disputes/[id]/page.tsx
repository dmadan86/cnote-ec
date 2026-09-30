import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { disputesEnabled, getDispute } from "@/lib/disputes";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { EvidenceForm, IntentButton, TextForm } from "@/features/disputes/forms";
import { el } from "@/features/billing/rich-value";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("disputes"))("detailMetaTitle") };
}
export const dynamic = "force-dynamic";
const label = (s: string) => s.replace(/_/g, " ");

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/disputes/${id}`);
  const t = await getTranslations("disputes");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const known = (group: string, v: string) => (t.has(`${group}.${v}`) ? t(`${group}.${v}`) : label(v));
  const back = <Link href="/disputes" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft className="size-4" aria-hidden /> {t("back")}</Link>;
  if (!disputesEnabled()) return <div className="space-y-4">{back}<Alert tone="info">{t("notAvailable")}</Alert></div>;
  const res = await load(() => getDispute(actorOf(session), id));
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const d = res.data;
  if (!d) return <div className="space-y-4">{back}<Alert tone="warning">{t("notFound")}</Alert></div>;
  const active = !["resolved", "withdrawn"].includes(d.status);
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={t("detailTitle", { type: known("type", d.type) })} description={active ? t("decisionDue", { date: formatDateTime(d.dueAt, locale) }) : undefined} actions={<Badge tone="brand">{known("status", d.status)}</Badge>} />
      {d.can.respond ? <Alert tone="warning">{t("respondBy", { date: formatDateTime(d.responseDueAt, locale) })}</Alert> : null}
      <Card>
        <CardHeader><CardTitle>{t("summary")}</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-sm">
          <p className="whitespace-pre-wrap text-ink">{d.description}</p>
          <p className="text-muted">{d.amountPaise !== null ? t.rich("claimedHeld", { claimed: el(<Money paise={d.amountPaise} />), held: el(<Money paise={d.atStakePaise} />) }) : t.rich("held", { held: el(<Money paise={d.atStakePaise} />) })}</p>
        </CardBody>
      </Card>
      {d.proposal ? (
        <Card>
          <CardHeader><CardTitle>{t("proposedTitle")}</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p>{t.rich("proposal", { outcome: known("outcome", d.proposal.outcome), refund: el(<Money paise={d.proposal.refundPaise} />), release: el(<Money paise={d.proposal.releasePaise} />), date: formatDateTime(d.proposal.escalationDeadline, locale) })}</p>
            {d.can.escalate ? <IntentButton disputeId={d.id} intent="escalate" label={t("askPerson")} /> : null}
          </CardBody>
        </Card>
      ) : null}
      {d.decision ? (
        <Card>
          <CardHeader><CardTitle>{t("decisionTitle")}</CardTitle></CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p className="font-medium text-ink">{t(d.decision.decidedBy === "auto" ? "decidedAuto" : "decidedAdjudicator", { outcome: known("outcome", d.decision.outcome) })}</p>
            <p>{t.rich("decisionAmounts", { refund: el(<Money paise={d.decision.refundPaise} />), release: el(<Money paise={d.decision.releasePaise} />) })}</p>
            <p className="text-muted">{d.decision.rationale}</p>
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>{t("evidenceTitle")}</CardTitle></CardHeader>
        <CardBody>
          {d.evidence.length === 0 ? <p className="text-sm text-muted">{t("noEvidence")}</p> : (
            <ul className="space-y-3">
              {d.evidence.map((e) => (
                <li key={e.id} className="rounded-card border border-border p-3 text-sm">
                  <p className="text-xs text-muted">{t("messageMeta", { who: e.party === "system" ? t("partySystem") : e.mine ? t("partyYou") : t("partyBuyer"), when: formatDateTime(e.createdAt, locale) })}</p>
                  {e.text ? <p className="mt-1 whitespace-pre-wrap text-ink">{e.text}</p> : null}
                  {e.hasFile && !e.purged ? <a className="mt-1 inline-flex min-h-11 items-center font-medium text-brand-700 underline" href={`/disputes/${d.id}/evidence/${e.id}`}>{known("evidenceKind", e.kind)} ({e.mimeType})</a> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {d.can.respond || d.can.addEvidence ? (
        <Card><CardHeader><CardTitle>{d.can.respond ? t("respondTitle") : t("addEvidenceTitle")}</CardTitle></CardHeader><CardBody><EvidenceForm disputeId={d.id} respond={d.can.respond} /></CardBody></Card>
      ) : null}
      {d.can.appeal ? (
        <Card><CardHeader><CardTitle>{t("appealTitle")}</CardTitle></CardHeader><CardBody><TextForm disputeId={d.id} intent="appeal" label={t("appealLabel")} submit={t("appealSubmit")} /></CardBody></Card>
      ) : d.appeal ? <Alert tone="info">{d.appeal.resolutionNote ? t("appealNote", { status: known("appealStatus", d.appeal.status), note: d.appeal.resolutionNote }) : t("appealReceived", { status: known("appealStatus", d.appeal.status) })}</Alert> : null}
      <Card>
        <CardHeader><CardTitle>{t("messagesTitle")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <ul className="space-y-2">{d.messages.map((m) => <li key={m.id} className="rounded-card bg-surface p-3 text-sm"><span className="text-xs text-muted">{t("messageMeta", { who: m.mine ? t("messageYou") : t("messageTeam"), when: formatDateTime(m.createdAt, locale) })}</span><br />{m.body}</li>)}</ul>
          <TextForm disputeId={d.id} intent="message" label={t("writeMessage")} submit={t("send")} />
        </CardBody>
      </Card>
      {d.can.withdraw ? <IntentButton disputeId={d.id} intent="withdraw" label={t("withdraw")} /> : null}
    </div>
  );
}
