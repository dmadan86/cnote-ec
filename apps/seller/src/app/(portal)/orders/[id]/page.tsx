import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { actorOf } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { DispatchPhotosPanel } from "@/features/quality/dispatch-photos";
import { EscrowPanel } from "@/features/escrow/escrow-panel";
import { OrderActions } from "@/features/orders/order-actions";
import { OrderStatusBadge } from "@/features/orders/status";

export const metadata: Metadata = { title: "Order" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/orders/${id}`);
  const res = await load(() => enquiry.getOrder(actorOf(session), id));
  const back = (
    <Link href="/orders" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> Back to orders
    </Link>
  );
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const o = res.data;
  if (!o || o.role !== "seller") return <div className="space-y-4">{back}<Alert tone="warning">We could not find this order, or it belongs to another business.</Alert></div>;
  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={o.enquiryTitle} description={`Order for ${o.counterparty.name}`} actions={<OrderStatusBadge status={o.status} />} />
      {o.status === "recorded" ? (
        <Alert tone="info">
          {o.sellerConfirmedAt ? "You confirmed these details. Waiting for the buyer to confirm." : "Check the details with the buyer, then confirm."} Payment is settled directly with the buyer; nothing goes through the platform yet.
        </Alert>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Order details</CardTitle></CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row k="Buyer" v={o.counterparty.name} />
            <Row k="Quantity" v={o.quantity ? `${o.quantity} ${o.unit ?? ""}` : "Not recorded"} />
            <Row k="Price per unit" v={o.pricePaise !== null ? <Money paise={o.pricePaise} unit={o.unit} /> : "Not recorded"} />
            <Row k="Total" v={o.totalPaise !== null ? <Money paise={o.totalPaise} /> : "Not recorded"} />
            <Row k="You confirmed" v={o.sellerConfirmedAt ? formatDateTime(o.sellerConfirmedAt) : "Not yet"} />
            <Row k="Buyer confirmed" v={o.buyerConfirmedAt ? formatDateTime(o.buyerConfirmedAt) : "Not yet"} />
          </dl>
        </CardBody>
      </Card>
      <EscrowPanel actor={actorOf(session)} orderId={o.id} />
      <OrderActions orderId={o.id} actions={o.actions} />
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
