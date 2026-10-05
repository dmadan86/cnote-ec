import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { AckForm, InvoiceForm } from "@/features/purchase-orders/forms";
import { InvoiceCard, PO_TONE, Row, day, inr } from "@/features/purchase-orders/views";
import { ReceiptsAndMatch } from "@/features/goods-returns/panels";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("purchaseOrders"))("metaTitle") };
}

export default async function SellerPurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/orders/${id}/purchase-order`);
  const t = await getTranslations("purchaseOrders");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const actor = actorOf(session);
  const back = (
    <Link href={`/orders/${id}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> {t("back")}
    </Link>
  );
  const res = await load(() => enquiry.getPurchaseOrderForOrder(actor, id));
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const po = res.data;
  if (!po || po.role !== "seller") return <div className="space-y-4">{back}<Alert tone="warning">{t("panelNone")}</Alert></div>;
  const today = enquiry.istDate(new Date());
  const cur = po.versions[0]!;
  const tax = po.intraState ? t("taxCgst") : t("taxIgst");
  return (
    <div className="space-y-6">
      {back}
      <PageHeader
        title={t("title", { number: po.number })}
        actions={<div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{t("version", { n: po.currentVersion })}</Badge><Badge tone={PO_TONE[po.status]}>{t(`status.${po.status}`)}</Badge></div>}
      />
      {po.status === "rejected" && cur.ackReason ? <Alert tone="warning">{t("ackReason", { reason: cur.ackReason })}</Alert> : null}
      {po.status === "cancelled" ? <Alert tone="info">{t("cancelledReason", { reason: po.cancelReason ?? "" })}</Alert> : null}
      {po.sellerMsme.covered ? (
        <Alert tone="info">{t("msmeYou", { category: po.sellerMsme.category ?? "" })}</Alert>
      ) : (
        <Alert tone="info">{t("msmeNot")} <Link href="/settings/company" className="font-medium underline">{t("msmeSettings")}</Link></Alert>
      )}

      {po.actions.acknowledge ? (
        <Card>
          <CardHeader><CardTitle>{t("ackForm.title")}</CardTitle></CardHeader>
          <CardBody><AckForm orderId={id} purchaseOrderId={po.id} /></CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("partiesTitle")}</CardTitle></CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row k={t("buyer")} v={<>{po.buyer.legalName ?? po.buyer.name}<br /><span className="font-mono text-xs">{po.buyer.gstinMasked ? t("gstinMasked", { gstin: po.buyer.gstinMasked }) : t("gstinNone")}</span></>} />
            <Row k={t("you")} v={<>{po.seller.legalName ?? po.seller.name}<br /><span className="font-mono text-xs">{po.seller.gstin ? t("gstin", { gstin: po.seller.gstin }) : t("gstinNone")}</span></>} />
            <Row k={t("deliverTo")} v={<>{po.deliveryAddress.line1}{po.deliveryAddress.line2 ? `, ${po.deliveryAddress.line2}` : ""}<br />{po.deliveryAddress.city}, {po.deliveryAddress.state} {po.deliveryAddress.pincode}</>} />
            <Row k={t("placeOfSupply")} v={t("placeOfSupplyValue", { code: po.placeOfSupply, tax })} />
            <Row k={t("paymentTerms")} v={t("paymentTermsValue", { days: po.paymentTermsDays })} />
            <Row k={t("expectedDelivery")} v={po.expectedDelivery ? day(po.expectedDelivery, locale) : t("notSet")} />
            {po.notes ? <Row k={t("notes")} v={po.notes} /> : null}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("linesTitle")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">{t("linesCaption")}</caption>
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="py-2 pe-2 text-start font-medium">{t("col.item")}</th>
                  <th scope="col" className="py-2 pe-2 text-start font-medium">{t("col.hsn")}</th>
                  <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.qty")}</th>
                  <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.rate")}</th>
                  <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.taxable")}</th>
                  <th scope="col" className="py-2 pe-2 text-end font-medium">{t("col.gst")}</th>
                  <th scope="col" className="py-2 text-end font-medium">{t("col.total")}</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((l) => (
                  <tr key={l.lineNo} className="border-b border-line align-top">
                    <th scope="row" className="py-2 pe-2 text-start font-normal">{l.description}{l.priceIncludesGst ? <span className="block text-xs text-muted">{t("priceIncludesGst")}</span> : null}</th>
                    <td className="py-2 pe-2">{l.hsn ?? "-"}</td>
                    <td className="py-2 pe-2 text-end tabular-nums">{l.quantity} {l.unit}</td>
                    <td className="py-2 pe-2 text-end tabular-nums">{inr(l.unitPricePaise)}</td>
                    <td className="py-2 pe-2 text-end tabular-nums">{inr(l.taxablePaise)}</td>
                    <td className="py-2 pe-2 text-end tabular-nums">{l.gstRateBps / 100}%</td>
                    <td className="py-2 text-end font-medium tabular-nums">{inr(l.totalPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ms-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt>{t("totals.taxable")}</dt><dd className="text-end tabular-nums">{inr(po.totals.taxablePaise)}</dd>
            {po.intraState ? (
              <><dt>{t("totals.cgst")}</dt><dd className="text-end tabular-nums">{inr(po.totals.cgstPaise)}</dd><dt>{t("totals.sgst")}</dt><dd className="text-end tabular-nums">{inr(po.totals.sgstPaise)}</dd></>
            ) : (
              <><dt>{t("totals.igst")}</dt><dd className="text-end tabular-nums">{inr(po.totals.igstPaise)}</dd></>
            )}
            <dt className="font-semibold">{t("totals.total")}</dt><dd className="text-end font-semibold tabular-nums">{inr(po.totals.totalPaise)}</dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("versionsTitle")}</CardTitle></CardHeader>
        <CardBody>
          <ul className="space-y-2 text-sm">
            {po.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t("versionRow", { n: v.version, total: inr(v.totalPaise), terms: t("paymentTermsValue", { days: v.paymentTermsDays }) })}{" "}
                  <Badge tone={v.ack === "accepted" ? "success" : v.ack === "rejected" ? "danger" : "warning"}>{t(`ack.${v.ack}`)}</Badge>
                </span>
                <a className="inline-flex min-h-11 items-center font-medium text-brand-700 underline" href={`/api/purchase-orders/${po.id}/pdf?v=${v.version}`}>{t("pdf", { n: v.version })}</a>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <section aria-labelledby="po-invoices" className="space-y-3">
        <h2 id="po-invoices" className="text-lg font-semibold text-ink">{t("invoices.title")}</h2>
        <dl className="grid grid-cols-2 gap-3 rounded-card border border-line bg-surface p-4 text-sm sm:grid-cols-5">
          <Row k={t("amounts.po")} v={inr(po.amounts.poPaise)} />
          <Row k={t("amounts.invoiced")} v={inr(po.amounts.invoicedPaise)} />
          <Row k={t("amounts.paid")} v={inr(po.amounts.paidPaise)} />
          <Row k={t("amounts.toInvoice")} v={inr(po.amounts.remainingToInvoicePaise)} />
          <Row k={t("amounts.outstanding")} v={<strong>{inr(po.amounts.outstandingPaise)}</strong>} />
        </dl>
        {po.invoices.length === 0 ? <p className="text-sm text-muted">{t("invoices.none")}</p> : (
          <ul className="space-y-3">
            {po.invoices.map((inv) => <li key={inv.id}><InvoiceCard inv={inv} locale={locale} orderId={id} /></li>)}
          </ul>
        )}
      </section>

      <ReceiptsAndMatch orderId={id} purchaseOrderId={po.id} session={session} />

      {po.actions.recordInvoice ? (
        <Card>
          <CardHeader><CardTitle>{t("invoiceForm.title")}</CardTitle></CardHeader>
          <CardBody><InvoiceForm orderId={id} purchaseOrderId={po.id} today={today} poLines={po.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: inr(Math.round(l.taxablePaise / l.quantity)) }))} /></CardBody>
        </Card>
      ) : null}
    </div>
  );
}
