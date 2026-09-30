import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card, CardBody, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { AutoRefresh } from "@/features/billing/checkout-forms";

export const metadata: Metadata = { title: "Payment status" };
export const dynamic = "force-dynamic";

export default async function BillingReturnPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSeller("/billing");
  const sp = await searchParams;
  const order = typeof sp.order === "string" ? sp.order : "";
  const res = /^[0-9a-f-]{36}$/i.test(order) ? await load(() => billing.getPaymentStatus({ businessId: session.business.id }, order, { sync: true })) : null;
  const o = res?.ok ? res.data : null;
  const pending = !o || o.status === "created" || o.status === "pending";

  return (
    <div className="space-y-6">
      <PageHeader title="Payment status" />
      <AutoRefresh active={!!o && pending} />
      {!o ? <Alert tone="danger">We could not find that payment.</Alert> : (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">Order {o.id.slice(0, 8)}</p>
            <p className="text-lg font-semibold text-ink">Total <Money paise={o.totalPaise} /></p>
            {o.status === "paid" || o.status === "refunded" || o.status === "partially_refunded" ? (
              <Alert tone="success">Payment received. Your plan or credits are active.</Alert>
            ) : o.status === "failed" ? (
              <Alert tone="danger">The payment did not go through{o.failureReason === "amount_mismatch" ? " (amount mismatch, please contact support)" : ""}. You have not been charged for this order. You can try again.</Alert>
            ) : (
              <Alert tone="info">Waiting for the bank to confirm. This page refreshes on its own; you can also leave and check Billing later.</Alert>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              {o.invoiceId ? <a href={`/api/invoices/${o.invoiceId}`} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white" download>Download tax invoice</a> : null}
              <Link href="/billing" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-ink">Back to billing</Link>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
