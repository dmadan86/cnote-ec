import type { PlanView } from "@cnote/billing";
import { Badge, Card, CardBody, CardTitle, Money } from "@cnote/ui";
import { Check } from "lucide-react";

/** `annualLines` maps a plan code to its already-translated annual price line (ADR-005 annual billing). */
export function PlanCards({ plans, sellerUrl, cta, ctaFree, annualLines }: { plans: PlanView[]; sellerUrl?: string; cta?: string; ctaFree?: string; annualLines?: Record<string, string> }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {plans.map((p) => (
        <Card key={p.code}>
          <CardBody className="flex h-full flex-col gap-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{p.name}</CardTitle>
              {p.monthlyPricePaise === 0 ? <Badge tone="success">Free forever</Badge> : null}
            </div>
            <p className="text-3xl font-extrabold text-ink">
              {p.monthlyPricePaise === 0 ? "₹0" : <Money paise={p.monthlyPricePaise} />}
              <span className="text-sm font-normal text-muted"> / month</span>
            </p>
            {annualLines?.[p.code] ? <p className="-mt-2 text-sm text-ink">{annualLines[p.code]}</p> : null}
            <p className="text-sm text-ink">
              <strong>{p.monthlyCredits}</strong> lead credits every month
              {p.monthlyPricePaise > 0 ? <span className="text-muted"> (about ₹{Math.round(p.monthlyPricePaise / 100 / p.monthlyCredits)} per lead)</span> : null}
            </p>
            <ul className="flex flex-col gap-2 text-sm text-ink">
              {p.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> {f}
                </li>
              ))}
            </ul>
            {sellerUrl ? (
              <a
                href={p.monthlyPricePaise === 0 ? sellerUrl : `${sellerUrl}/billing/checkout?plan=${encodeURIComponent(p.code)}`}
                className="mt-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-brand-600 px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50"
              >
                {p.monthlyPricePaise === 0 ? ctaFree : cta}
              </a>
            ) : null}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
