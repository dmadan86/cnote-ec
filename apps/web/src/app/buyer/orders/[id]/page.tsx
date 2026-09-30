import { getOrder } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, Money, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TrackingTimeline } from "@/features/orders/tracking-timeline";
import { OrderActions } from "@/features/orders/order-actions";
import { EscrowPanel } from "@/features/escrow/escrow-panel";
import { OrderStatusBadge } from "@/features/orders/status";
import { ReportProblem } from "@/features/disputes/report-problem";

export const metadata: Metadata = { title: "Order" };
const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function BuyerOrderPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/orders/${id}`);
  const o = await getOrder(actorOf(s), id);
  if (!o || o.role !== "buyer") notFound();
  return (
    <Container className="max-w-3xl py-8">
      <Link href="/buyer/orders" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">Back to orders</Link>
      <PageHeader title={o.enquiryTitle} description={`Order with ${o.counterparty.name}`} actions={<OrderStatusBadge status={o.status} />} />
      <div className="mt-6 flex flex-col gap-6">
        {o.status === "recorded" ? (
          <Alert tone="info">
            {o.buyerConfirmedAt ? "You confirmed these details. Waiting for the seller to confirm." : "Check the details below with the seller, then confirm."} This order is settled directly with the seller; no payment goes through us yet.
          </Alert>
        ) : null}
        <Card>
          <CardBody className="flex flex-col gap-4">
            <CardTitle>Order details</CardTitle>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row k="Seller" v={o.counterparty.name} />
              <Row k="Quantity" v={o.quantity ? `${o.quantity} ${o.unit ?? ""}` : "Not recorded"} />
              <Row k="Price per unit" v={o.pricePaise !== null ? <Money paise={o.pricePaise} unit={o.unit} /> : "Not recorded"} />
              <Row k="Total" v={o.totalPaise !== null ? <Money paise={o.totalPaise} /> : "Not recorded"} />
              <Row k="You confirmed" v={o.buyerConfirmedAt ? dt.format(new Date(o.buyerConfirmedAt)) : "Not yet"} />
              <Row k="Seller confirmed" v={o.sellerConfirmedAt ? dt.format(new Date(o.sellerConfirmedAt)) : "Not yet"} />
            </dl>
          </CardBody>
        </Card>
        <TrackingTimeline actor={actorOf(s)} order={o} />
        <EscrowPanel actor={actorOf(s)} order={o} />
        <OrderActions orderId={o.id} actions={o.actions} />
        <ReportProblem orderId={o.id} status={o.status} actor={actorOf(s)} />
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
