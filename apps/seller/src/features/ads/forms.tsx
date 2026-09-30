"use client";
import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Button, Field, Input, Textarea } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import {
  addKeywordsAction, createCampaignAction, endCampaignAction, pauseCampaignAction, removeKeywordAction, resumeCampaignAction, submitCampaignAction, updateBudgetAction, type AdsResult,
} from "./actions";
import { inr, num } from "./format";

export interface ProductChoice {
  id: string;
  title: string;
  eligible: boolean;
  note?: string;
}
export interface CategoryChoice {
  id: string;
  name: string;
}

const PRESETS = [100, 250, 500, 1000];
const SURFACES = [
  { id: "search", label: "search" },
  { id: "category", label: "category" },
  { id: "product_similar", label: "product_similar" },
] as const;

/**
 * Campaign builder. Sections read top to bottom like a stepper (setup, products, targeting, review), with a live cost preview
 * beside them. Nothing is pre-ticked except the two search surfaces, and submitting only sends the campaign for review:
 * nothing is charged until buyers actually click.
 */
export function NewCampaignForm({ products, categories, minDailyRupees, cpcSearchPaise, today }: { products: ProductChoice[]; categories: CategoryChoice[]; minDailyRupees: number; cpcSearchPaise: number | null; today: string }) {
  const t = useTranslations("ads");
  const locale = useLocale();
  const [state, action] = useActionState<AdsResult | null, FormData>(createCampaignAction, null);
  const [daily, setDaily] = useState<number>(Math.max(minDailyRupees, 250));
  const tooLow = daily < minDailyRupees;
  const maxClicks = cpcSearchPaise ? Math.floor((daily * 100) / cpcSearchPaise) : null;
  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-10">
        <section aria-labelledby="s1" className="space-y-4">
          <h2 id="s1" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">1.</span>{t("form.s1")}</h2>
          <Field label={t("form.name")} htmlFor="name" error={fieldError(state, "name")}><Input id="name" name="name" required minLength={2} maxLength={120} placeholder={t("form.namePlaceholder")} /></Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">{t("form.dailyBudget")}</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("form.presets")}>
              {PRESETS.map((p) => (
                <Button key={p} type="button" variant={daily === p ? "primary" : "outline"} className="min-h-11" onClick={() => setDaily(p)} aria-pressed={daily === p}>₹{num(p, locale)}</Button>
              ))}
            </div>
            <Field label={t("form.orEnter")} htmlFor="dailyRupees" error={fieldError(state, "dailyRupees")} hint={t("form.minHint", { min: minDailyRupees })}>
              <Input id="dailyRupees" name="dailyRupees" type="number" inputMode="numeric" min={minDailyRupees} step={1} value={daily} onChange={(e) => setDaily(Number(e.target.value))} required />
            </Field>
            {tooLow ? <Alert tone="warning">{t("form.minWarn", { min: minDailyRupees })}</Alert> : null}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("form.totalBudget")} htmlFor="totalRupees" hint={t("form.totalHint")}><Input id="totalRupees" name="totalRupees" type="number" inputMode="numeric" min={0} /></Field>
            <Field label={t("form.startDate")} htmlFor="startsAt" error={fieldError(state, "startsAt")}><Input id="startsAt" name="startsAt" type="date" defaultValue={today} min={today} required /></Field>
            <Field label={t("form.endDate")} htmlFor="endsAt" hint={t("form.endHint")}><Input id="endsAt" name="endsAt" type="date" min={today} /></Field>
          </div>
        </section>

        <section aria-labelledby="s2" className="space-y-3">
          <h2 id="s2" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">2.</span>{t("form.s2")}</h2>
          <p className="text-sm text-muted">{t("form.productsIntro")}</p>
          {products.length ? (
            <ul className="divide-y divide-line rounded-card border border-line bg-surface">
              {products.map((p) => (
                <li key={p.id} className="flex items-start gap-3 p-3">
                  <input id={`p-${p.id}`} type="checkbox" name="listingId" value={p.id} className="mt-1 size-5" />
                  <label htmlFor={`p-${p.id}`} className="text-sm text-ink">
                    {p.title}
                    {!p.eligible ? <span className="block text-xs text-muted">{t("form.notRunUntilFixed", { note: p.note ?? "" })}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          ) : <Alert tone="info">{t("form.noProducts")}</Alert>}
        </section>

        <section aria-labelledby="s3" className="space-y-4">
          <h2 id="s3" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">3.</span>{t("form.s3")}</h2>
          <Field
            label={t("form.keywords")}
            htmlFor="keywords"
            error={fieldError(state, "keywords")}
            hint={t("form.keywordsHint")}
          >
            <Textarea id="keywords" name="keywords" rows={5} placeholder={t("form.keywordsPlaceholder")} />
          </Field>
          {categories.length ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">{t("form.categories")}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {categories.map((c) => (
                  <label key={c.id} className="flex min-h-11 items-center gap-2 text-sm text-ink"><input type="checkbox" name="categoryId" value={c.id} className="size-5" />{c.name}</label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">{t("form.where")}</legend>
            {SURFACES.map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm text-ink"><input type="checkbox" name="surface" value={s.id} defaultChecked={s.id !== "product_similar"} className="size-5" />{t(`surface.${s.label}`)}</label>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("form.states")} htmlFor="state" hint={t("form.statesHint")}><Input id="state" name="state" /></Field>
            <Field label={t("form.pincodes")} htmlFor="pincodes" hint={t("form.pincodesHint")}><Input id="pincodes" name="pincodes" /></Field>
          </div>
        </section>

        <section aria-labelledby="s4" className="space-y-3">
          <h2 id="s4" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">4.</span>{t("form.s4")}</h2>
          <FormAlert state={state} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton name="intent" value="submit" pendingText={t("form.sending")} disabled={tooLow}>{t("form.sendReview")}</SubmitButton>
            <SubmitButton name="intent" value="draft" variant="outline" pendingText={t("form.saving")}>{t("form.saveDraft")}</SubmitButton>
          </div>
        </section>
      </div>

      <aside aria-label={t("form.costPreview")} className="h-fit space-y-3 rounded-card border border-line bg-surface p-4 lg:sticky lg:top-6">
        <h2 className="text-base font-bold text-ink">{t("form.whatCosts")}</h2>
        <dl className="space-y-2 text-sm">
          <div><dt className="text-muted">{t("form.cpcSearch")}</dt><dd className="font-semibold text-ink">{cpcSearchPaise ? inr(cpcSearchPaise, locale) : t("form.cpcUnset")}</dd></div>
          <div><dt className="text-muted">{t("form.maxDay")}</dt><dd className="font-semibold text-ink">{inr(daily * 100, locale)}</dd></div>
          {maxClicks !== null ? <div><dt className="text-muted">{t("form.maxClicks")}</dt><dd className="font-semibold text-ink">{t("form.aboutClicks", { count: num(maxClicks, locale) })}</dd></div> : null}
        </dl>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          <li>{t("form.t1")}</li>
          <li>{t("form.t2")}</li>
          <li>{t("form.t3")}</li>
          <li>{t("form.t4")}</li>
        </ul>
      </aside>
    </form>
  );
}

function Act({ id, action, label, pending, variant = "outline", confirm }: { id: string; action: (p: AdsResult | null, fd: FormData) => Promise<AdsResult>; label: string; pending: string; variant?: "outline" | "primary" | "danger"; confirm?: string }) {
  const t = useTranslations("ads");
  const tc = useTranslations("common");
  const [state, act] = useActionState<AdsResult | null, FormData>(action, null);
  const [asking, setAsking] = useState(false);
  if (confirm && !asking) return <Button variant={variant} className="min-h-11" onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <form action={act} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      {confirm ? <p className="text-sm text-ink">{confirm}</p> : null}
      <div className="flex gap-2">
        <SubmitButton variant={variant} pendingText={pending}>{confirm ? t("controls.yesEnd") : label}</SubmitButton>
        {confirm ? <Button variant="ghost" className="min-h-11" onClick={() => setAsking(false)}>{tc("cancel")}</Button> : null}
      </div>
      <FormAlert state={state} />
    </form>
  );
}

export function CampaignControls({ id, status }: { id: string; status: string }) {
  const t = useTranslations("ads");
  return (
    <div className="flex flex-wrap items-start gap-3">
      {status === "draft" || status === "rejected" ? <Act id={id} action={submitCampaignAction} label={t("form.sendReview")} pending={t("form.sending")} variant="primary" /> : null}
      {["approved", "active", "exhausted"].includes(status) ? <Act id={id} action={pauseCampaignAction} label={t("controls.pause")} pending={t("controls.pausing")} /> : null}
      {status === "paused" ? <Act id={id} action={resumeCampaignAction} label={t("controls.resume")} pending={t("controls.resuming")} variant="primary" /> : null}
      {!["ended", "suspended"].includes(status) ? <Act id={id} action={endCampaignAction} label={t("controls.end")} pending={t("controls.ending")} variant="danger" confirm={t("controls.confirmEnd")} /> : null}
    </div>
  );
}

export function BudgetForm({ id, currentRupees, minRupees }: { id: string; currentRupees: number; minRupees: number }) {
  const t = useTranslations("ads.controls");
  const tf = useTranslations("ads.form");
  const [state, action] = useActionState<ActionResult<null> | null, FormData>(updateBudgetAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <Field label={t("budgetLabel")} htmlFor="dailyRupees" hint={t("budgetHint")}>
        <Input id="dailyRupees" name="dailyRupees" type="number" inputMode="numeric" min={minRupees} defaultValue={currentRupees} required className="w-40" />
      </Field>
      <SubmitButton variant="outline" pendingText={tf("saving")}>{t("updateBudget")}</SubmitButton>
      <div className="w-full"><FormAlert state={state} />{state?.ok ? <Alert tone="success">{t("budgetUpdated")}</Alert> : null}</div>
    </form>
  );
}

export function KeywordForm({ id }: { id: string }) {
  const t = useTranslations("ads.controls");
  const [state, action] = useActionState<AdsResult | null, FormData>(addKeywordsAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <Field label={t("addKeywords")} htmlFor="keywords" hint={t("addKeywordsHint")}>
        <Textarea id="keywords" name="keywords" rows={3} />
      </Field>
      <SubmitButton variant="outline" pendingText={t("adding")}>{t("addKeywords")}</SubmitButton>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("added")}</Alert> : null}
    </form>
  );
}

export function RemoveKeyword({ id, keywordId, text }: { id: string; keywordId: string; text: string }) {
  const t = useTranslations("ads.controls");
  const [state, action] = useActionState<AdsResult | null, FormData>(removeKeywordAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="keywordId" value={keywordId} />
      <SubmitButton variant="ghost" pendingText="…" aria-label={t("removeKeyword", { text })}>{t("remove")}</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}
