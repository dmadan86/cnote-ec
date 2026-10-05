import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, Money, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { getSample, samplesEnabled } from "@/lib/samples";
import { EvaluateForm, IntentButton } from "@/features/samples/forms";
import { fill, sampleLabels } from "@/features/samples/labels";
import { SampleProgress, SampleStatusBadge } from "@/features/samples/view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("sample") };
}

export default async function BuyerSamplePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/samples/${id}`);
  const locale = await getRequestLocale();
  const l = await sampleLabels(locale);
  if (!samplesEnabled()) return <Container className="py-8"><Alert tone="info">{l.notAvailable}</Alert></Container>;
  const x = await getSample(actorOf(s), id);
  if (!x || x.role !== "buyer") notFound();
  const dt = (iso: string) => formatDate(iso, locale, { dateStyle: "medium", timeStyle: "short" });
  const day = (iso: string) => formatDate(iso, locale, { dateStyle: "medium" });
  return (
    <Container className="max-w-3xl py-8">
      <Link href="/buyer/samples" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{l.back}</Link>
      <PageHeader title={x.subject} description={x.seller.name} actions={<SampleStatusBadge status={x.status} labels={l} />} />
      <div className="mt-6 flex flex-col gap-6">
        {x.status === "requested" ? <Alert tone="info">{fill(l.waitingSupplier, { date: dt(x.respondBy) })}</Alert> : null}

        <Card><CardBody><SampleProgress sample={x} labels={l} locale={locale} /></CardBody></Card>

        <Card>
          <CardBody className="flex flex-col gap-4">
            <CardTitle>{l.detailsHeading}</CardTitle>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Row k={l.supplier} v={x.seller.name} />
              <Row k={l.quantity} v={`${x.quantity}${x.unit ? ` ${x.unit}` : ""}`} />
              <Row k={l.requestedOn} v={dt(x.createdAt)} />
              {x.buyerNote ? <Row k={l.yourNote} v={x.buyerNote} /> : null}
              {x.shipTo ? <Row k={l.shipTo} v={<>{x.shipTo.name}<br />{x.shipTo.line1}{x.shipTo.line2 ? `, ${x.shipTo.line2}` : ""}<br />{x.shipTo.city} {x.shipTo.pincode}</>} /> : null}
              <Row
                k={l.paymentHeading}
                v={x.payment.free ? l.paymentFree : <><Money paise={x.payment.amountPaise} /><br /><span className="text-xs text-muted">{x.payment.adjustableAgainstBulk ? l.paymentAdjustable : l.paymentNotAdjustable}</span></>}
              />
            </dl>
            <p className="text-xs text-muted">{x.payment.free ? l.paymentOffPlatform : `${l.paymentOffPlatform}${x.payment.receivedAt ? ` ${l.paymentReceived}.` : ""}`}</p>
          </CardBody>
        </Card>

        {x.status === "declined" ? (
          <Card><CardBody className="flex flex-col gap-1">
            <CardTitle>{l.declineHeading}</CardTitle>
            <p className="text-sm text-ink">{x.declineReason ? l[`decline_${x.declineReason}` as keyof typeof l] : null}</p>
            {x.declineNote ? <p className="text-sm text-muted">{l.supplierNote}: {x.declineNote}</p> : null}
          </CardBody></Card>
        ) : null}

        {x.courier || x.expectedDispatchBy ? (
          <Card><CardBody className="flex flex-col gap-1">
            <CardTitle>{l.dispatchHeading}</CardTitle>
            {x.courier ? <p className="text-sm text-ink">{l.courier}: {x.courier}{x.trackingRef ? ` · ${l.tracking}: ${x.trackingRef}` : ""}</p> : null}
            {!x.courier && x.expectedDispatchBy ? <p className="text-sm text-muted">{fill(l.expectedDispatch, { date: day(x.expectedDispatchBy) })}</p> : null}
          </CardBody></Card>
        ) : null}

        {x.can.cancel ? <IntentButton sampleId={x.id} intent="cancel" label={l.cancel} labels={l} /> : null}
        {x.can.markDelivered ? <IntentButton sampleId={x.id} intent="received" label={l.markReceived} variant="primary" labels={l} /> : null}

        {x.can.evaluate ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{l.evalTitle}</CardTitle>
            <p className="text-sm text-muted">{l.evalIntro}</p>
            <EvaluateForm sampleId={x.id} labels={l} />
          </CardBody></Card>
        ) : null}

        {x.evaluation ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{l.verdictLegend}</CardTitle>
            <p className="text-sm text-ink">{fill(x.evaluation.approved ? l.verdictApproved : l.verdictRejected, { date: day(x.evaluation.at) })}</p>
            {x.evaluation.reasons.length ? <ul className="list-disc pl-5 text-sm text-ink">{x.evaluation.reasons.map((r) => <li key={r}>{l[`reject_${r}` as keyof typeof l]}</li>)}</ul> : null}
            {x.evaluation.notes ? <p className="text-sm text-ink">{x.evaluation.notes}</p> : null}
            {x.evaluation.photos.length ? (
              <ul className="flex flex-wrap gap-2">
                {x.evaluation.photos.map((p, i) => (
                  <li key={p.id}>
                    <Image unoptimized src={`/buyer/samples/${x.id}/photos/${p.id}`} alt={fill(l.photoAlt, { n: i + 1 })} width={96} height={96} className="size-24 rounded-md border border-line object-cover" />
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody></Card>
        ) : null}

        {x.status === "approved" ? (
          <Card><CardBody className="flex flex-col gap-3">
            <CardTitle>{l.bulkTitle}</CardTitle>
            <p className="text-sm text-muted">{l.bulkIntro}</p>
            {x.bulkEnquiryId ? (
              <div className="flex flex-col gap-2">
                <Alert tone="success">{l.bulkRaised}</Alert>
                <Link href={`/buyer/enquiries/${x.bulkEnquiryId}`} className={buttonClasses("outline")}>{l.viewRequirement}</Link>
              </div>
            ) : (
              <div className="flex flex-wrap items-start gap-3">
                {x.can.acceptLinkedQuote ? <IntentButton sampleId={x.id} intent="acceptQuote" label={l.acceptQuote} variant="primary" labels={l} /> : null}
                {x.can.requestBulk ? <Link href={`/rfq/new?sample=${x.id}`} className={buttonClasses(x.can.acceptLinkedQuote ? "outline" : "primary")}>{l.requestBulk}</Link> : null}
              </div>
            )}
          </CardBody></Card>
        ) : null}
      </div>
    </Container>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex flex-col"><dt className="text-xs text-muted">{k}</dt><dd className="text-ink">{v}</dd></div>;
}
