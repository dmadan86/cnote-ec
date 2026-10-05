import { getOrder, getPurchaseOrderForOrder, istDate, purchaseOrdersEnabled, suggestPurchaseOrder } from "@cnote/enquiry";
import { listAddresses } from "@cnote/identity";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { CancelPoForm, PoForm, type AddressOption } from "@/features/purchase-orders/po-forms";
import { InvoiceCard, PO_TONE, Row, day, inr } from "@/features/purchase-orders/po-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "po" });
  return { title: t("metaTitle") };
}

export default async function BuyerPurchaseOrderPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/orders/${id}/purchase-order`);
  if (!purchaseOrdersEnabled()) notFound();
  const actor = actorOf(s);
  const order = await getOrder(actor, id);
  if (!order || order.role !== "buyer" || order.settlement === "ondc") notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "po" });
  const now = new Date();
  const today = istDate(now);
  const [po, addresses, suggestion] = await Promise.all([getPurchaseOrderForOrder(actor, id, now), listAddresses(s.business.id), suggestPurchaseOrder(actor, id, now)]);
  const options: AddressOption[] = addresses.map((a) => ({ id: a.id, label: a.label, isDefault: a.isDefault, summary: `${a.line1}, ${a.city} ${a.pincode}` }));

  const back = <Link href={`/buyer/orders/${id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("back")}</Link>;

  if (!po) {
    return (
      <Container className="max-w-3xl py-8">
        {back}
        <PageHeader title={t("issueTitle")} description={order.enquiryTitle} />
        <div className="mt-6 flex flex-col gap-4">
          <Alert tone="info">{t("issueIntro")}</Alert>
          {order.status === "cancelled" ? null : (
            <Card>
              <CardBody>
                <PoForm
                  mode="issue"
                  orderId={id}
                  addresses={options}
                  today={today}
                  defaults={{ addressId: null, paymentTermsDays: suggestion?.paymentTermsDays ?? null, expectedDelivery: suggestion?.expectedDelivery ?? null, notes: null, gstPercent: suggestion?.gstPercent ?? 18 }}
                />
              </CardBody>
            </Card>
          )}
        </div>
      </Container>
    );
  }

  const cur = po.versions[0]!;
  const payInvoices = po.invoices;
  const tax = po.intraState ? t("taxCgst") : t("taxIgst");
  return (
    <Container className="max-w-3xl py-8">
      {back}
      <PageHeader
        title={t("title", { number: po.number })}
        description={order.enquiryTitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{t("version", { n: po.currentVersion })}</Badge>
            <Badge tone={PO_TONE[po.status]}>{t(`status.${po.status}`)}</Badge>
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-6">
        {po.status === "rejected" && cur.ackReason ? <Alert tone="warning">{t("ackReason", { reason: cur.ackReason })}</Alert> : null}
        {po.status === "cancelled" ? <Alert tone="info">{t("cancelledReason", { reason: po.cancelReason ?? "" })}</Alert> : null}
        {po.sellerMsme.covered ? (
          <Alert tone="info">
            <p>{t("msmeCovered")}</p>
            <p className="mt-1">{t("msmeAdvice")}</p>
          </Alert>
        ) : null}

        <Card>
          <CardBody className="flex flex-col gap-4">
            <CardTitle>{t("partiesTitle")}</CardTitle>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Row k={t("you")} v={<>{po.buyer.legalName ?? po.buyer.name}<br /><span className="font-mono text-xs">{po.buyer.gstin ? t("gstin", { gstin: po.buyer.gstin }) : t("gstinNone")}</span></>} />
              <Row k={t("seller")} v={<>{po.seller.legalName ?? po.seller.name}<br /><span className="font-mono text-xs">{po.seller.gstinMasked ? t("gstinMasked", { gstin: po.seller.gstinMasked }) : t("gstinNone")}</span></>} />
              <Row k={t("deliverTo")} v={<>{po.deliveryAddress.line1}{po.deliveryAddress.line2 ? `, ${po.deliveryAddress.line2}` : ""}<br />{po.deliveryAddress.city}, {po.deliveryAddress.state} {po.deliveryAddress.pincode}</>} />
              <Row k={t("placeOfSupply")} v={t("placeOfSupplyValue", { code: po.placeOfSupply, tax })} />
              <Row k={t("paymentTerms")} v={t("paymentTermsValue", { days: po.paymentTermsDays })} />
              <Row k={t("expectedDelivery")} v={po.expectedDelivery ? day(po.expectedDelivery, locale) : t("notSet")} />
              {po.notes ? <Row k={t("notes")} v={po.notes} /> : null}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-3">
            <CardTitle>{t("linesTitle")}</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <caption className="sr-only">{t("linesCaption")}</caption>
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th scope="col" className="py-2 pe-2 font-medium">{t("col.item")}</th>
                    <th scope="col" className="py-2 pe-2 font-medium">{t("col.hsn")}</th>
                    <th scope="col" className="py-2 pe-2 text-right font-medium">{t("col.qty")}</th>
                    <th scope="col" className="py-2 pe-2 text-right font-medium">{t("col.rate")}</th>
                    <th scope="col" className="py-2 pe-2 text-right font-medium">{t("col.taxable")}</th>
                    <th scope="col" className="py-2 pe-2 text-right font-medium">{t("col.gst")}</th>
                    <th scope="col" className="py-2 text-right font-medium">{t("col.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.lineNo} className="border-b border-line align-top">
                      <th scope="row" className="py-2 pe-2 text-left font-normal">{l.description}{l.priceIncludesGst ? <span className="block text-xs text-muted">{t("priceIncludesGst")}</span> : null}</th>
                      <td className="py-2 pe-2">{l.hsn ?? "-"}</td>
                      <td className="py-2 pe-2 text-right tabular-nums">{l.quantity} {l.unit}</td>
                      <td className="py-2 pe-2 text-right tabular-nums">{inr(l.unitPricePaise)}</td>
                      <td className="py-2 pe-2 text-right tabular-nums">{inr(l.taxablePaise)}</td>
                      <td className="py-2 pe-2 text-right tabular-nums">{l.gstRateBps / 100}%</td>
                      <td className="py-2 text-right font-medium tabular-nums">{inr(l.totalPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="ms-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
              <dt>{t("totals.taxable")}</dt><dd className="text-right tabular-nums">{inr(po.totals.taxablePaise)}</dd>
              {po.intraState ? (
                <>
                  <dt>{t("totals.cgst")}</dt><dd className="text-right tabular-nums">{inr(po.totals.cgstPaise)}</dd>
                  <dt>{t("totals.sgst")}</dt><dd className="text-right tabular-nums">{inr(po.totals.sgstPaise)}</dd>
                </>
              ) : (
                <><dt>{t("totals.igst")}</dt><dd className="text-right tabular-nums">{inr(po.totals.igstPaise)}</dd></>
              )}
              <dt className="font-semibold">{t("totals.total")}</dt><dd className="text-right font-semibold tabular-nums">{inr(po.totals.totalPaise)}</dd>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-3">
            <CardTitle>{t("versionsTitle")}</CardTitle>
            <ul className="flex flex-col gap-2 text-sm">
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

        <section aria-labelledby="po-invoices" className="flex flex-col gap-3">
          <h2 id="po-invoices" className="text-lg font-semibold text-ink">{t("invoices.title")}</h2>
          <dl className="grid grid-cols-2 gap-3 rounded-card border border-line bg-surface p-4 text-sm sm:grid-cols-5">
            <Row k={t("amounts.po")} v={inr(po.amounts.poPaise)} />
            <Row k={t("amounts.invoiced")} v={inr(po.amounts.invoicedPaise)} />
            <Row k={t("amounts.paid")} v={inr(po.amounts.paidPaise)} />
            <Row k={t("amounts.toInvoice")} v={inr(po.amounts.remainingToInvoicePaise)} />
            <Row k={t("amounts.outstanding")} v={<strong>{inr(po.amounts.outstandingPaise)}</strong>} />
          </dl>
          {payInvoices.length === 0 ? <p className="text-sm text-muted">{t("invoices.none")}</p> : (
            <ul className="flex flex-col gap-3">
              {payInvoices.map((inv) => (
                <li key={inv.id}><InvoiceCard inv={inv} locale={locale} orderId={id} today={today} canPay={po.actions.payInvoices} /></li>
              ))}
            </ul>
          )}
        </section>

        {po.actions.amend ? (
          <details className="rounded-card border border-line bg-surface p-4">
            <summary className="min-h-11 cursor-pointer font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{t("form.amendTitle")}</summary>
            <div className="flex flex-col gap-3 pt-3">
              <p className="text-sm text-muted">{t("form.amendHint")}</p>
              <PoForm
                mode="amend"
                currentAddress={`${po.deliveryAddress.line1}, ${po.deliveryAddress.city} ${po.deliveryAddress.pincode}`}
                orderId={id}
                purchaseOrderId={po.id}
                addresses={options}
                today={today}
                defaults={{ addressId: null, paymentTermsDays: po.paymentTermsDays, expectedDelivery: po.expectedDelivery, notes: po.notes, gstPercent: 18 }}
              />
            </div>
          </details>
        ) : null}
        {po.actions.cancel ? (
          <details className="rounded-card border border-line bg-surface p-4">
            <summary className="min-h-11 cursor-pointer font-semibold text-ink focus-visible:outline-2 focus-visible:outline-brand-600">{t("form.cancelTitle")}</summary>
            <div className="flex flex-col gap-3 pt-3">
              <p className="text-sm text-muted">{t("form.cancelHint")}</p>
              <CancelPoForm orderId={id} purchaseOrderId={po.id} />
            </div>
          </details>
        ) : null}
      </div>
    </Container>
  );
}
