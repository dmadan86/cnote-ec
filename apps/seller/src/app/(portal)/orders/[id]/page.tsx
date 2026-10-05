import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { DispatchPhotosPanel } from "@/features/quality/dispatch-photos";
import { EscrowPanel } from "@/features/escrow/escrow-panel";
import { GoldenSample } from "@/features/samples/golden-sample";
import { FulfilmentPanel } from "@/features/orders/fulfilment-panel";
import { OrderActions } from "@/features/orders/order-actions";
import { OrderStatusBadge } from "@/features/orders/status";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("orders"))("detailMetaTitle") };
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/orders/${id}`);
  const t = await getTranslations("orders");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => enquiry.getOrder(actorOf(session), id));
  const back = (
    <Link href="/orders" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> {t("back")}
    </Link>
  );
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const o = res.data;
  if (!o || o.role !== "seller") return <div className="space-y-4">{back}<Alert tone="warning">{t("notFound")}</Alert></div>;
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={o.enquiryTitle} description={t("orderFor", { name: o.counterparty.name })} actions={<OrderStatusBadge status={o.status} />} />
      {o.status === "recorded" ? (
        <Alert tone="info">
          {o.sellerConfirmedAt ? t("youConfirmedWaiting") : t("checkAndConfirm")} {t("paymentNote")}
        </Alert>
      ) : null}
      <Card>
        <CardHeader><CardTitle>{t("detailsTitle")}</CardTitle></CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row k={t("buyer")} v={o.counterparty.name} />
            <Row k={t("quantity")} v={o.quantity ? `${o.quantity} ${o.unit ?? ""}` : t("notRecorded")} />
            <Row k={t("pricePerUnit")} v={o.pricePaise !== null ? <Money paise={o.pricePaise} unit={o.unit} /> : t("notRecorded")} />
            <Row k={t("total")} v={o.totalPaise !== null ? <Money paise={o.totalPaise} /> : t("notRecorded")} />
            <Row k={t("youConfirmed")} v={o.sellerConfirmedAt ? formatDateTime(o.sellerConfirmedAt, locale) : t("notYet")} />
            <Row k={t("buyerConfirmed")} v={o.buyerConfirmedAt ? formatDateTime(o.buyerConfirmedAt, locale) : t("notYet")} />
          </dl>
        </CardBody>
      </Card>
      <GoldenSample orderId={o.id} actor={actorOf(session)} />
      <EscrowPanel actor={actorOf(session)} orderId={o.id} />
      <OrderActions orderId={o.id} actions={o.actions} />
      <FulfilmentPanel actor={actorOf(session)} order={o} />
      <DispatchPhotosPanel actor={actorOf(session)} orderId={o.id} />
    </div>
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
