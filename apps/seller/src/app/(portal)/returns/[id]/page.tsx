import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, type BadgeTone } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { CreditNoteForm, DecideForm, ReceiveForm } from "@/features/goods-returns/forms";
import { Row, day, inr } from "@/features/purchase-orders/views";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("goodsReturns"))("detail.metaTitle") };
}

const TONE: Record<string, BadgeTone> = { requested: "warning", approved: "brand", rejected: "danger", cancelled: "neutral", shipped: "brand", received: "brand", credited: "success" };

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/returns/${id}`);
  const t = await getTranslations("goodsReturns");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  if (!enquiry.purchaseOrdersEnabled()) notFound();
  const actor = actorOf(session);
  const res = await load(() => enquiry.getGoodsReturn(actor, id));
  const back = <Link href="/returns" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft className="size-4" aria-hidden /> {t("detail.back")}</Link>;
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const r = res.data;
  if (!r || r.role !== "seller") notFound();
  const invoices = r.actions.credit ? (await enquiry.listCreditableInvoices(actor, r.purchaseOrderId)).map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, creditable: inr(i.creditablePaise) })) : [];
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={t("detail.title", { number: r.number })} description={t("detail.subtitle", { grn: r.receiptNumber, po: r.purchaseOrderNumber })} actions={<Badge tone={TONE[r.status] ?? "neutral"}>{t(`status.${r.status}`)}</Badge>} />
      {r.status === "rejected" ? <Alert tone="info">{t("detail.rejectedNote", { reason: r.decisionNote ?? "" })}{r.disputeId ? ` ${t("detail.disputed")}` : ""}</Alert> : null}
      {r.status === "approved" ? <Alert tone="info">{t("detail.approvedNote")}</Alert> : null}
      {r.shipment ? <Alert tone="info">{t("detail.shipped", { ref: `${r.shipment.courier ? `${r.shipment.courier}: ` : ""}${r.shipment.trackingRef}` })}</Alert> : null}
      {r.creditNote ? <Alert tone="success">{t("detail.credited", { number: r.creditNote.number, amount: inr(r.creditNote.totalPaise), date: day(r.creditNote.noteDate, locale) })}</Alert> : null}

      <Card>
        <CardHeader><CardTitle>{t("detail.details")}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row k={t("detail.buyer")} v={r.buyerName} />
            <Row k={t("detail.reason")} v={t(`reasons.${r.reasonCode}`)} />
            <Row k={t("detail.estimated")} v={inr(r.estimatedPaise)} />
            <Row k={t("detail.requestedOn")} v={day(r.createdAt.slice(0, 10), locale)} />
            {r.reasonNote ? <Row k={t("detail.note")} v={r.reasonNote} /> : null}
          </dl>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <caption className="sr-only">{t("detail.linesCaption")}</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="py-2 pe-2 text-start font-medium">{t("detail.item")}</th>
                  <th scope="col" className="py-2 pe-2 text-end font-medium">{t("detail.quantity")}</th>
                  <th scope="col" className="py-2 text-start font-medium">{t("detail.from")}</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id} className="border-b border-line">
                    <th scope="row" className="py-2 pe-2 text-start font-normal">{l.description}</th>
                    <td className="py-2 pe-2 text-end tabular-nums">{l.quantity} {l.unit}</td>
                    <td className="py-2">{t(`source.${l.source}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {r.actions.approve ? <Card><CardHeader><CardTitle>{t("decide.title")}</CardTitle></CardHeader><CardBody><DecideForm returnId={r.id} /></CardBody></Card> : null}
      {r.actions.receive ? <Card><CardHeader><CardTitle>{t("receive.title")}</CardTitle></CardHeader><CardBody className="space-y-3"><p className="text-sm text-muted">{t("receive.hint")}</p><ReceiveForm returnId={r.id} /></CardBody></Card> : null}
      {r.actions.credit ? <Card><CardHeader><CardTitle>{t("credit.title")}</CardTitle></CardHeader><CardBody><CreditNoteForm returnId={r.id} invoices={invoices} today={enquiry.istDate(new Date())} estimate={inr(r.estimatedPaise)} /></CardBody></Card> : null}
      <p><Link href={`/orders/${r.orderId}/purchase-order`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("detail.toPo")}</Link></p>
    </div>
  );
}
