import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, PageHeader, Stat } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { CancelPlan, SubscribeButton } from "@/features/billing/plan-actions";

export const metadata: Metadata = { title: "Billing" };

const REASON = { grant: "Credits added", consume: "Lead accepted", refund: "Refunded", expire: "Expired" } as const;

export default async function BillingPage() {
  const session = await requireSeller("/billing");
  const id = session.business.id;
  const [balance, sub, plans, ledger] = await Promise.all([
    load(() => billing.getBalance(id)),
    load(() => billing.getActiveSubscription(id)),
    load(() => billing.listPlans()),
    load(() => billing.getLedger(id, 30)),
  ]);
  const activeCode = sub.ok && sub.data?.status === "active" ? sub.data.planCode : null;
  const activePlan = plans.ok ? plans.data.find((p) => p.code === activeCode) : undefined;

  return (
    <div className="space-y-8">
      <PageHeader title="Billing" description="Public prices. One credit per accepted lead. Unused credits roll over for 90 days." />

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Lead credits" value={balance.ok ? balance.data : "-"} hint="Spendable now. Refunded credits come back here." />
        <Stat
          label="Current plan"
          value={activePlan?.name ?? (activeCode ?? "None")}
          hint={sub.ok && sub.data && sub.data.status === "active" ? `Runs until ${formatDate(sub.data.periodEnd)}. It does not renew unless you choose a plan again.` : undefined}
        />
      </div>
      {!balance.ok ? <Alert tone="danger">{balance.error}</Alert> : null}

      {sub.ok && sub.data?.status === "active" && activeCode && activePlan && activePlan.monthlyPricePaise > 0 ? (
        <CancelPlan endsOn={formatDate(sub.data.periodEnd)} />
      ) : null}

      <section aria-labelledby="plans" className="space-y-3">
        <h2 id="plans" className="text-lg font-bold text-ink">Plans</h2>
        {!plans.ok ? <Alert tone="danger">{plans.error}</Alert> : (
          <ul className="grid gap-4 md:grid-cols-3">
            {plans.data.map((p) => (
              <li key={p.code}>
                <Card className="h-full">
                  <CardBody className="flex h-full flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-ink">{p.name}</h3>
                      {p.code === activeCode ? <Badge tone="success">Current</Badge> : null}
                    </div>
                    <p>{p.monthlyPricePaise === 0 ? <span className="text-2xl font-bold text-ink">Free</span> : <Money paise={p.monthlyPricePaise} unit="month" className="text-2xl" />}</p>
                    <p className="text-sm text-ink">{p.monthlyCredits} lead credits per month</p>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                    <div className="mt-auto pt-2">
                      <SubscribeButton planCode={p.code} current={p.code === activeCode} label={p.monthlyPricePaise === 0 ? "Switch to Free" : `Start ${p.name} for one month`} />
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">Payment is simulated during this early phase. Your badge and ranking never depend on your plan.</p>
      </section>

      <Card>
        <CardHeader><CardTitle>Credit history</CardTitle></CardHeader>
        <CardBody>
          {!ledger.ok ? <Alert tone="danger">{ledger.error}</Alert> : ledger.data.length === 0 ? <p className="text-sm text-muted">No credit activity yet.</p> : (
            <ul className="divide-y divide-line">
              {ledger.data.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink">{REASON[e.reason]}</p>
                    <p className="text-xs text-muted">{formatDateTime(e.createdAt)}{e.expiresAt ? ` · expires ${formatDate(e.expiresAt)}` : ""}</p>
                  </div>
                  <span className={`font-semibold tabular-nums ${e.delta >= 0 ? "text-success" : "text-ink"}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
