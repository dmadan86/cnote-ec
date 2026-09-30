import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card, CardBody, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { MockPayForm } from "@/features/billing/checkout-forms";

export const metadata: Metadata = { title: "Test payment" };
export const dynamic = "force-dynamic";

/** Local stand-in for the gateway's hosted page. Exists only with PAYMENTS_PROVIDER=mock outside production. */
export default async function MockPayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production" || (process.env.PAYMENTS_PROVIDER || "mock") !== "mock") notFound();
  const session = await requireSeller("/billing");
  const sp = await searchParams;
  const order = typeof sp.order === "string" && /^[0-9a-f-]{36}$/i.test(sp.order) ? sp.order : null;
  if (!order) notFound();
  const res = await load(() => billing.getPaymentStatus({ businessId: session.business.id }, order));
  if (!res.ok) notFound();
  return (
    <div className="space-y-6">
      <PageHeader title="Test payment" description="Simulated gateway. Nothing is charged." />
      <Card>
        <CardBody className="space-y-3">
          <p className="text-lg font-semibold text-ink">Pay <Money paise={res.data.totalPaise} /> (incl. GST)</p>
          {res.data.status === "pending" ? <MockPayForm orderId={order} /> : <Alert tone="info">This order is already {res.data.status}.</Alert>}
        </CardBody>
      </Card>
    </div>
  );
}
