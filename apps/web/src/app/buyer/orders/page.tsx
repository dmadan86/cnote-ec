import { listOrders } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Card, CardBody, Container, EmptyState, Money, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { OrderStatusBadge } from "@/features/orders/status";

export const metadata: Metadata = { title: "Your orders" };
const date = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

export default async function BuyerOrdersPage(props: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await props.searchParams;
  const s = await requireBusiness("/buyer/orders");
  const page = await listOrders(actorOf(s), { role: "buyer", cursor });
  return (
    <Container className="py-8">
      <PageHeader title="Your orders" description="Deals you closed with sellers. Confirm the details with the seller and track each order to delivery." />
      <div className="mt-6">
        {page.items.length === 0 ? (
          <EmptyState title="No orders yet" description="When you tell us a deal closed, it appears here." action={<Link href="/buyer/enquiries" className={buttonClasses("outline")}>Your requirements</Link>} />
        ) : (
          <ul className="flex flex-col gap-3">
            {page.items.map((o) => (
              <li key={o.id}>
                <Link href={`/buyer/orders/${o.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                  <Card className="transition-colors hover:border-brand-600">
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{o.enquiryTitle}</p>
                        <p className="mt-0.5 text-xs text-muted">{o.counterparty.name} · {date.format(new Date(o.createdAt))}</p>
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
        {page.nextCursor ? (
          <nav aria-label="Orders pagination" className="mt-6">
            <Link href={`/buyer/orders?cursor=${page.nextCursor}`} className={buttonClasses("outline")}>Older orders</Link>
          </nav>
        ) : null}
      </div>
    </Container>
  );
}
