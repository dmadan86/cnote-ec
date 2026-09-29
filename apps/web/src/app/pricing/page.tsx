import { listPlans } from "@cnote/billing";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { CreditCalculator } from "@/features/billing/credit-calculator";
import { PlanCards } from "@/features/billing/plan-cards";

export const metadata: Metadata = { title: "Pricing", description: "Public, self-serve pricing. Pay only for leads you accept." };
export const revalidate = 300;

const PROMISES = [
  ["What is a credit?", "One credit is spent when you accept a lead. Receiving or declining a lead costs nothing."],
  ["Auto-refund", "If a buyer is unreachable or flagged fake within 72 hours, the credit comes back automatically. No ticket needed."],
  ["90-day rollover", "Unused credits stay spendable for 90 days, so a slow month does not waste them."],
  ["No auto-renew", "Plans never renew or upgrade on their own. You confirm every purchase."],
  ["Cancel in 3 taps", "Account, Plan, Cancel. Self-serve, no calls and no retention hoops."],
  ["Trust is not for sale", "Your plan never changes your verification badge or how you rank. Ranking is relevance and trust."],
] as const;

export default async function PricingPage() {
  const plans = await listPlans();
  return (
    <Container className="py-10">
      <PageHeader title="Simple, public pricing" description="Every plan is listed here. There is no sales-rep-only price and nothing hidden." />
      <div className="mt-8 flex flex-col gap-10">
        <PlanCards plans={plans} />
        <div className="grid gap-6 lg:grid-cols-2">
          <CreditCalculator plans={plans} />
          <dl className="grid gap-4 sm:grid-cols-2">
            {PROMISES.map(([t, d]) => (
              <div key={t}>
                <dt className="font-semibold text-ink">{t}</dt>
                <dd className="mt-0.5 text-sm text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Container>
  );
}
