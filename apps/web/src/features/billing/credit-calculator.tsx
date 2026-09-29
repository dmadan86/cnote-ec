"use client";
import type { PlanView } from "@cnote/billing";
import { Card, CardBody, CardTitle, Field, Input, Money } from "@cnote/ui";
import { useId, useState } from "react";

/** Recommends the cheapest plan whose monthly credits cover the expected accepted leads (ADR-005). */
export function recommendPlan(plans: PlanView[], leadsPerMonth: number): { plan: PlanView; extraNeeded: number } | null {
  if (plans.length === 0) return null;
  const sorted = [...plans].sort((a, b) => a.monthlyPricePaise - b.monthlyPricePaise);
  const fit = sorted.find((p) => p.monthlyCredits >= leadsPerMonth);
  if (fit) return { plan: fit, extraNeeded: 0 };
  const biggest = sorted[sorted.length - 1]!;
  return { plan: biggest, extraNeeded: leadsPerMonth - biggest.monthlyCredits };
}

export function CreditCalculator({ plans }: { plans: PlanView[] }) {
  const id = useId();
  const [leads, setLeads] = useState(20);
  const rec = recommendPlan(plans, leads);
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <CardTitle>How many leads will you accept each month?</CardTitle>
        <Field label="Leads per month" htmlFor={id} hint="You only spend a credit when you accept a lead.">
          <Input id={id} type="number" min={0} max={2000} value={leads} onChange={(e) => setLeads(Math.max(0, Math.min(2000, Number(e.target.value) || 0)))} />
        </Field>
        {rec ? (
          <div className="rounded-lg bg-brand-50 p-4 text-sm" aria-live="polite">
            <p className="font-semibold text-ink">
              {rec.plan.name} plan: {rec.plan.monthlyPricePaise === 0 ? "₹0" : <Money paise={rec.plan.monthlyPricePaise} />} / month
            </p>
            <p className="mt-1 text-muted">
              {rec.extraNeeded === 0
                ? `Covers all ${leads} leads with ${rec.plan.monthlyCredits - leads} credits to spare, and unused credits roll over for 90 days.`
                : `Covers ${rec.plan.monthlyCredits} of your ${leads} leads. Credits roll over for 90 days, so a quieter month tops up the next.`}
            </p>
            {leads > 0 && rec.plan.monthlyPricePaise > 0 ? (
              <p className="mt-1 text-muted">Effective cost: about ₹{(rec.plan.monthlyPricePaise / 100 / leads).toFixed(0)} per accepted lead.</p>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
