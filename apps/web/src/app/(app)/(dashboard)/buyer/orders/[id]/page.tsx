import { getOrder, purchaseOrderSummaries, purchaseOrdersEnabled, rateContractLinkForOrder, rateContractsEnabled } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardTitle, Container, Money, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { TrackingTimeline } from "@/features/orders/tracking-timeline";
import { OrderActions } from "@/features/orders/order-actions";
import { EscrowPanel } from "@/features/escrow/escrow-panel";
import { OrderStatusBadge } from "@/features/orders/status";
import { RequestAgain } from "@/features/retention/request-again";
import { ReportProblem } from "@/features/disputes/report-problem";
import { PO_TONE } from "@/features/purchase-orders/po-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("order") };
}

export default async function BuyerOrderPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/orders/${id}`);
  const o = await getOrder(actorOf(s), id);
  if (!o || o.role !== "buyer") notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "buyer" });
  const tp = await getTranslations({ locale, namespace: "po" });
  const tg = await getTranslations({ locale, namespace: "grn" });
  const poSummary = purchaseOrdersEnabled() && o.settlement !== "ondc" && o.status !== "cancelled" ? (await purchaseOrderSummaries(actorOf(s), [o.id])).get(o.id) ?? null : undefined;
  const rcOn = rateContractsEnabled();
  const tc = await getTranslations({ locale, namespace: "contracts" });
  const rcLink = rcOn ? await rateContractLinkForOrder(actorOf(s), o.id) : null;
  const dt = { format: (d: Date) => formatDate(d, locale, { dateStyle: "medium", timeStyle: "short" }) };
  return (
    <Container className="max-w-3xl py-8">
      <Link href="/buyer/orders" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("backToOrders")}</Link>
      <PageHeader title={o.enquiryTitle} description={t("orderWith", { name: o.counterparty.name })} actions={<><RequestAgain enquiryId={o.enquiryId} orderId={o.id} locale={locale} /><OrderStatusBadge status={o.status} /></>} />
      <div className="mt-6 flex flex-col gap-6">
        {o.status === "recorded" ? (
          <Alert tone="info">
            {o.buyerConfirmedAt ? t("recordedConfirmed") : t("recordedUnconfirmed")}
          </Alert>
        ) : null}
        <Card>
          <CardBody className="flex flex-col gap-4">
            <CardTitle>{t("orderDetails")}</CardTitle>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row k={t("seller")} v={o.counterparty.name} />
              <Row k={t("quantity")} v={o.quantity ? `${o.quantity} ${o.unit ?? ""}` : t("notRecorded")} />
              <Row k={t("pricePerUnit")} v={o.pricePaise !== null ? <Money paise={o.pricePaise} unit={o.unit} /> : t("notRecorded")} />
              <Row k={t("total")} v={o.totalPaise !== null ? <Money paise={o.totalPaise} /> : t("notRecorded")} />
              <Row k={t("youConfirmed")} v={o.buyerConfirmedAt ? dt.format(new Date(o.buyerConfirmedAt)) : t("notYet")} />
              <Row k={t("sellerConfirmed")} v={o.sellerConfirmedAt ? dt.format(new Date(o.sellerConfirmedAt)) : t("notYet")} />
            </dl>
          </CardBody>
        </Card>
        {poSummary !== undefined ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <CardTitle>{tp("panelTitle")}</CardTitle>
              {poSummary ? (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{poSummary.number}</span>
                  <Badge tone={PO_TONE[poSummary.status]}>{tp(`status.${poSummary.status}`)}</Badge>
                </p>
              ) : <p className="text-sm text-muted">{tp("panelNone")}</p>}
              <div>
                <Link href={`/buyer/orders/${o.id}/purchase-order`} className={buttonClasses(poSummary ? "outline" : "primary")}>{poSummary ? tp("panelOpen") : tp("panelIssue")}</Link>
              </div>
              {poSummary ? (
                <div className="flex flex-wrap gap-2">
                  <Link href={`/buyer/orders/${o.id}/receipts`} className={buttonClasses("outline")}>{tg("panelReceipts")}</Link>
                  <Link href={`/buyer/orders/${o.id}/match`} className={buttonClasses("outline")}>{tg("panelMatch")}</Link>
                  <Link href="/buyer/returns" className={buttonClasses("outline")}>{tg("panelReturns")}</Link>
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
        {rcLink ? (
          <Card>
            <CardBody className="flex flex-col gap-2">
              <CardTitle>{tc("orderPanel.title")}</CardTitle>
              <p className="text-sm">{tc("orderPanel.fromContract", { n: rcLink.callOffNo, number: rcLink.number })}</p>
              <div><Link href={`/buyer/contracts/${rcLink.contractId}`} className={buttonClasses("outline")}>{tc("orderPanel.open")}</Link></div>
            </CardBody>
          </Card>
        ) : rcOn && o.quoteId && o.role === "buyer" ? (
          <Card>
            <CardBody className="flex flex-col gap-2">
              <CardTitle>{tc("orderPanel.convertTitle")}</CardTitle>
              <p className="text-sm text-muted">{tc("orderPanel.convertNote")}</p>
              <div><Link href={`/buyer/contracts/new?quote=${o.quoteId}`} className={buttonClasses("outline")}>{tc("orderPanel.convert")}</Link></div>
            </CardBody>
          </Card>
        ) : null}
        <TrackingTimeline actor={actorOf(s)} order={o} locale={locale} />
        <EscrowPanel actor={actorOf(s)} order={o} locale={locale} />
        <OrderActions orderId={o.id} actions={o.actions} />
        <ReportProblem orderId={o.id} status={o.status} actor={actorOf(s)} locale={locale} />
      </div>
    </Container>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}
