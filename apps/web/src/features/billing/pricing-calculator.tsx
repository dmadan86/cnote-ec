"use client";
// ADR-005 pricing calculator. The maths lives in @cnote/billing/pricing (shared with the public /pricing page); this
// is only the form. Results sit in a polite live region so a screen reader hears the new numbers as inputs change.
import { calculatePricing, DEFAULT_GST_RATE_BPS, MAX_CALCULATOR_LEADS, recommendPlan, type BillingInterval } from "@cnote/billing/pricing";
import { Card, CardBody, CardTitle, Field, Input, Select } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { formatPaise } from "./format-paise";

export interface CalculatorPlan { code: string; name: string; monthlyPricePaise: number; monthlyCredits: number; annualDiscountBps: number }

export function PricingCalculator({ plans, gstRateBps = DEFAULT_GST_RATE_BPS, initialLeads = 20 }: { plans: CalculatorPlan[]; gstRateBps?: number; initialLeads?: number }) {
  const t = useTranslations("pricing2.calc");
  const id = useId();
  const [leadsText, setLeadsText] = useState(String(initialLeads));
  const [planCode, setPlanCode] = useState(() => recommendPlan(plans, initialLeads)?.code ?? plans[0]?.code ?? "");
  const [chosen, setChosen] = useState<BillingInterval>("monthly");

  const plan = plans.find((p) => p.code === planCode) ?? plans[0];
  if (!plan) return null;
  const parsed = Number.parseInt(leadsText, 10);
  const leads = Number.isFinite(parsed) ? Math.max(0, Math.min(MAX_CALCULATOR_LEADS, parsed)) : 0;
  const paid = plan.monthlyPricePaise > 0;
  const interval: BillingInterval = paid ? chosen : "monthly";
  const r = calculatePricing({ plan, interval, leadsPerMonth: leads, gstRateBps });
  const rec = recommendPlan(plans, leads);
  const percent = plan.annualDiscountBps / 100;

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <CardTitle>{t("title")}</CardTitle>
        <Field label={t("leads")} htmlFor={`${id}-leads`} hint={t("leadsHint")}>
          <Input
            id={`${id}-leads`}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_CALCULATOR_LEADS}
            value={leadsText}
            onChange={(e) => setLeadsText(e.target.value)}
          />
        </Field>
        <Field label={t("plan")} htmlFor={`${id}-plan`}>
          <Select id={`${id}-plan`} value={plan.code} onChange={(e) => setPlanCode(e.target.value)}>
            {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </Select>
        </Field>
        {paid ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ink">{t("billing")}</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {(["monthly", "annual"] as const).map((v) => (
                <label key={v} className="inline-flex min-h-11 items-center gap-2 text-sm text-ink">
                  <input type="radio" name={`${id}-interval`} value={v} checked={interval === v} onChange={() => setChosen(v)} className="size-6 accent-brand-600" />
                  {v === "monthly" ? t("monthly") : t("annual", { percent })}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div role="status" aria-live="polite" aria-atomic="true" aria-label={t("resultsLabel")} className="space-y-1.5 rounded-lg bg-brand-50 p-4 text-sm text-ink">
          {!paid ? (
            <p className="font-semibold">{t("freePlan", { credits: r.creditsPerMonth })}</p>
          ) : interval === "monthly" ? (
            <p className="font-semibold">{t("priceMonthly", { total: formatPaise(r.totalPaise), ex: formatPaise(r.exGstPaise), gst: formatPaise(r.gstPaise) })}</p>
          ) : (
            <p className="font-semibold">
              {t("priceAnnual", { total: formatPaise(r.totalPaise), ex: formatPaise(r.exGstPaise), gst: formatPaise(r.gstPaise), perMonth: formatPaise(r.monthlyEquivalentPaise), saving: formatPaise(r.annualSavingPaise) })}
            </p>
          )}
          {leads === 0 ? <p className="text-muted">{t("noLeads")}</p> : null}
          {r.costPerLeadPaise !== null && leads > 0 ? <p>{t("perLead", { amount: formatPaise(r.costPerLeadPaise), covered: r.coveredLeadsPerMonth, leads: r.leadsPerMonth })}</p> : null}
          {r.shortfallLeadsPerMonth > 0 ? <p>{t("shortfall", { count: r.shortfallLeadsPerMonth })}</p> : null}
          {r.spareCreditsPerMonth > 0 && leads > 0 ? <p>{t("spare", { count: r.spareCreditsPerMonth })}</p> : null}
          <p className="text-muted">{interval === "annual" ? t("expiryAnnual", { days: r.creditExpiryDays }) : t("expiry", { days: r.creditExpiryDays })}</p>
          {rec && rec.code !== plan.code && leads > 0 ? <p>{t("recommend", { leads: r.leadsPerMonth, plan: rec.name })}</p> : null}
          <p className="text-muted">{t("noAutoRenew")}</p>
        </div>
      </CardBody>
    </Card>
  );
}
