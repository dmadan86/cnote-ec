import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Card, CardBody, EmptyState, Money, PageHeader, buttonClasses, type BadgeTone } from "@cnote/ui";
import { listSellerOrders, type OndcOrderStatus } from "@/lib/ondc";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { OrderDecision } from "../forms";

export const metadata: Metadata = { title: "ONDC orders" };

const STATUS: Record<OndcOrderStatus, { label: string; tone: BadgeTone }> = {
  created: { label: "Needs your decision", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  in_progress: { label: "In progress", tone: "brand" },
  completed: { label: "Completed", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "danger" },
};

export default async function OndcOrdersPage() {
  const session = await requireSeller("/ondc/orders");
  const res = await load(() => listSellerOrders(session.business.id));
  return (
    <div className="space-y-6">
      <PageHeader title="ONDC orders" description="Orders placed by buyers on the ONDC network. Accept or reject each one; the buyer's app is told straight away." actions={<Link href="/ondc" className={buttonClasses("outline", "md", "min-h-11")}>ONDC settings</Link>} />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : res.data.length === 0 ? <EmptyState title="No ONDC orders yet" description="Orders from the network appear here." /> : (
        <ul className="grid gap-3">
          {res.data.map((o) => (
            <li key={o.id}>
              <Card><CardBody className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{o.lines.map((l) => `${l.name} x ${l.count}`).join(", ") || "Order"}</p>
                    <p className="mt-0.5 text-xs text-muted">From {o.bapId} · {formatDate(o.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-3"><Money paise={o.totalPaise} /><Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge></div>
                </div>
                {o.status === "created" ? <OrderDecision orderId={o.id} /> : null}
              </CardBody></Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
