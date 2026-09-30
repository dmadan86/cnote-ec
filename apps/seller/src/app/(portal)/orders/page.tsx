import type { Metadata } from "next";
import Link from "next/link";
import { actorOf } from "@cnote/next-kit";
import { Alert, Card, CardBody, EmptyState, Money, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { OrderStatusBadge } from "@/features/orders/status";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const session = await requireSeller("/orders");
  const res = await load(() => enquiry.listOrders(actorOf(session), { role: "seller", cursor }));
  if (!res.ok) return <div className="space-y-6"><PageHeader title="Orders" /><Alert tone="danger">{res.error}</Alert></div>;
  const { items, nextCursor } = res.data;
  return (
    <div className="space-y-6">
      <PageHeader title="Orders" description="Deals reported as won. Confirm the terms with the buyer, then mark each order dispatched." />
      {items.length === 0 ? (
        <EmptyState title="No orders yet" description="When you or the buyer report a deal as won, it appears here." action={<Link href="/leads" className={buttonClasses("outline", "md", "min-h-11")}>Go to leads</Link>} />
      ) : (
        <ul className="grid gap-3">
          {items.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{o.enquiryTitle}</p>
                      <p className="mt-0.5 text-xs text-muted">{o.counterparty.name} · {formatDate(o.createdAt)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {o.totalPaise !== null ? <Money paise={o.totalPaise} /> : null}
                      <OrderStatusBadge status={o.status} />
                    </div>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? <nav aria-label="Orders pagination"><Link href={`/orders?cursor=${nextCursor}`} className={buttonClasses("outline", "md", "min-h-11")}>Older orders</Link></nav> : null}
    </div>
  );
}
