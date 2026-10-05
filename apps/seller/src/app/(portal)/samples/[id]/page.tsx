import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, PageHeader, type BadgeTone } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate, formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { getSample, samplesEnabled, type SampleStatus } from "@/lib/samples";
import { AcceptForm, DeclineForm, DispatchForm, IntentButton } from "@/features/samples/forms";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("samples"))("detailMetaTitle") };
}
export const dynamic = "force-dynamic";

const TONE: Record<SampleStatus, BadgeTone> = {
  requested: "warning", accepted: "brand", declined: "neutral", dispatched: "brand", delivered: "warning", approved: "success", rejected: "danger", expired: "neutral", cancelled: "neutral",
};

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex flex-col"><dt className="text-xs text-muted">{k}</dt><dd className="text-ink">{v}</dd></div>;
}

export default async function SamplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/samples/${id}`);
  const t = await getTranslations("samples");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const back = <Link href="/samples" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft className="size-4" aria-hidden /> {t("back")}</Link>;
  if (!samplesEnabled()) return <div className="space-y-4">{back}<Alert tone="info">{t("notAvailable")}</Alert></div>;
  const res = await load(() => getSample(actorOf(session), id));
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const x = res.data;
  if (!x || x.role !== "seller") return <div className="space-y-4">{back}<Alert tone="warning">{t("notFound")}</Alert></div>;
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={x.subject} description={x.buyer.name} actions={<Badge tone={TONE[x.status]}>{t(`status.${x.status}`)}</Badge>} />
      {x.can.respond ? <Alert tone="warning">{t("replyBy", { date: formatDateTime(x.respondBy, locale) })}</Alert> : null}
      {x.status === "requested" && x.overdue ? <Alert tone="danger">{t("pastDeadline")}</Alert> : null}

      <Card>
        <CardHeader><CardTitle>{t("details")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row k={t("buyer")} v={x.buyer.name} />
            <Row k={t("buyerTier")} v={x.buyer.verificationTier} />
            <Row k={t("quantity")} v={`${x.quantity}${x.unit ? ` ${x.unit}` : ""}`} />
            <Row k={t("requestedOn")} v={formatDateTime(x.createdAt, locale)} />
            {x.buyerNote ? <Row k={t("buyerNote")} v={x.buyerNote} /> : null}
            <Row
              k={t("shipTo")}
              v={x.shipTo ? <>{x.shipTo.name}{x.shipTo.phone ? ` · ${x.shipTo.phone}` : ""}<br />{x.shipTo.line1}{x.shipTo.line2 ? `, ${x.shipTo.line2}` : ""}<br />{x.shipTo.city} {x.shipTo.pincode}</> : <span className="text-muted">{t("shipHidden")}</span>}
            />
            <Row
              k={t("payment")}
              v={x.payment.free ? t("free") : <><Money paise={x.payment.amountPaise} /><br /><span className="text-xs text-muted">{x.payment.adjustableAgainstBulk ? t("adjustable") : t("notAdjustable")}</span></>}
            />
          </dl>
          <p className="text-xs text-muted">{t("paymentOffPlatform")}{x.payment.receivedAt ? ` ${t("paymentReceived")}.` : ""}</p>
          {x.courier ? <p className="text-sm text-ink">{t("sent", { courier: x.courier, tracking: x.trackingRef ?? "-" })}</p> : null}
          {x.expectedDispatchBy && x.status === "accepted" ? <p className="text-sm text-muted">{t("expectedDispatch", { date: formatDate(x.expectedDispatchBy, locale) })}</p> : null}
          {x.status === "declined" && x.declineReason ? <p className="text-sm text-ink">{t(`declineReasons.${x.declineReason}`)}{x.declineNote ? ` · ${x.declineNote}` : ""}</p> : null}
        </CardBody>
      </Card>

      {x.can.respond ? (
        <>
          <Card><CardHeader><CardTitle>{t("acceptTitle")}</CardTitle></CardHeader><CardBody><AcceptForm sampleId={x.id} defaultRupees={x.payment.amountPaise ? String(x.payment.amountPaise / 100) : "0"} /></CardBody></Card>
          <Card><CardHeader><CardTitle>{t("declineTitle")}</CardTitle></CardHeader><CardBody><DeclineForm sampleId={x.id} /></CardBody></Card>
        </>
      ) : null}
      {x.can.dispatch ? <Card><CardHeader><CardTitle>{t("dispatchTitle")}</CardTitle></CardHeader><CardBody><DispatchForm sampleId={x.id} /></CardBody></Card> : null}
      {x.can.markDelivered ? <IntentButton sampleId={x.id} intent="delivered" label={t("markDelivered")} /> : null}
      {x.can.recordPayment ? <IntentButton sampleId={x.id} intent="payment" label={t("recordPayment")} /> : null}

      {x.evaluation ? (
        <Card>
          <CardHeader><CardTitle>{t("verdict")}</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p className="text-ink">{t(x.evaluation.approved ? "verdictApproved" : "verdictRejected", { date: formatDate(x.evaluation.at, locale) })}</p>
            {x.evaluation.reasons.length ? <ul className="list-disc pl-5 text-ink">{x.evaluation.reasons.map((r) => <li key={r}>{t(`rejectReasons.${r}`)}</li>)}</ul> : null}
            {x.evaluation.notes ? <p className="text-ink">{x.evaluation.notes}</p> : null}
            {x.evaluation.photos.length ? (
              <ul className="flex flex-wrap gap-2">
                {x.evaluation.photos.map((p, i) => (
                  <li key={p.id}><Image unoptimized src={`/samples/${x.id}/photos/${p.id}`} alt={t("photoAlt", { n: i + 1 })} width={96} height={96} className="size-24 rounded-md border border-line object-cover" /></li>
                ))}
              </ul>
            ) : null}
            {x.bulkEnquiryId ? <Alert tone="success">{t("bulkRaised")}</Alert> : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
