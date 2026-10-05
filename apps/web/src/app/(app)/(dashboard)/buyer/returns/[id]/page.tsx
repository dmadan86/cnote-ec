import { getGoodsReturn, purchaseOrdersEnabled } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { CancelReturnForm, ReturnDisputeForm, ShipReturnForm } from "@/features/grn/forms";
import { ReturnBadge } from "@/features/grn/views";
import { day, inr, Row } from "@/features/purchase-orders/po-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grn" });
  return { title: t("returnDetail.metaTitle") };
}

export default async function BuyerReturnPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/returns/${id}`);
  if (!purchaseOrdersEnabled()) notFound();
  const r = await getGoodsReturn(actorOf(s), id);
  if (!r || r.role !== "buyer") notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grn.returnDetail" });
  const tr = await getTranslations({ locale, namespace: "grn.returnReasons" });
  return (
    <Container className="max-w-3xl py-8">
      <Link href="/buyer/returns" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("back")}</Link>
      <PageHeader title={t("title", { number: r.number })} description={t("subtitle", { grn: r.receiptNumber, po: r.purchaseOrderNumber })} actions={<ReturnBadge status={r.status} locale={locale} />} />
      <div className="mt-6 flex flex-col gap-6">
        {r.status === "rejected" ? <Alert tone="warning">{t("rejectedBy", { reason: r.decisionNote ?? "" })}</Alert> : null}
        {r.status === "approved" ? <Alert tone="info">{t("approvedNext")}</Alert> : null}
        {r.status === "requested" ? <Alert tone="info">{t("waiting")}</Alert> : null}
        {r.creditNote ? (
          <Alert tone="success">
            {t("credited", { number: r.creditNote.number, amount: inr(r.creditNote.totalPaise), date: day(r.creditNote.noteDate, locale) })}
          </Alert>
        ) : null}
        <Card>
          <CardBody className="flex flex-col gap-4">
            <CardTitle>{t("details")}</CardTitle>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row k={t("seller")} v={r.sellerName} />
              <Row k={t("reason")} v={tr(r.reasonCode)} />
              <Row k={t("estimated")} v={inr(r.estimatedPaise)} />
              <Row k={t("requestedOn")} v={day(r.createdAt.slice(0, 10), locale)} />
              {r.reasonNote ? <Row k={t("note")} v={r.reasonNote} /> : null}
              {r.shipment ? <Row k={t("shipment")} v={`${r.shipment.courier ? `${r.shipment.courier}: ` : ""}${r.shipment.trackingRef}`} /> : null}
              {r.receivedBackAt ? <Row k={t("receivedBack")} v={day(r.receivedBackAt.slice(0, 10), locale)} /> : null}
            </dl>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[22rem] text-sm">
                <caption className="sr-only">{t("linesCaption")}</caption>
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th scope="col" className="py-1 pr-3 font-medium">{t("item")}</th>
                    <th scope="col" className="px-2 py-1 text-right font-medium">{t("quantity")}</th>
                    <th scope="col" className="px-2 py-1 font-medium">{t("from")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.id} className="border-t border-line">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">{l.description}</th>
                      <td className="px-2 py-1.5 text-right tabular-nums">{l.quantity} {l.unit}</td>
                      <td className="px-2 py-1.5">{t(`source.${l.source}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
        {r.actions.cancel ? <Card><CardBody className="flex flex-col gap-2"><CardTitle>{t("cancelTitle")}</CardTitle><p className="text-sm text-muted">{t("cancelHint")}</p><CancelReturnForm returnId={r.id} /></CardBody></Card> : null}
        {r.actions.ship ? <Card><CardBody className="flex flex-col gap-3"><CardTitle>{t("shipTitle")}</CardTitle><p className="text-sm text-muted">{t("shipHint")}</p><ShipReturnForm returnId={r.id} /></CardBody></Card> : null}
        {r.actions.dispute ? <Card><CardBody className="flex flex-col gap-3"><CardTitle>{t("disputeTitle")}</CardTitle><ReturnDisputeForm returnId={r.id} /></CardBody></Card> : null}
        {r.disputeId ? <p><Link href={`/buyer/disputes/${r.disputeId}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 underline">{t("viewDispute")}</Link></p> : null}
        <p><Link href={`/buyer/orders/${r.orderId}/receipts`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("toReceipts")}</Link></p>
      </div>
    </Container>
  );
}
