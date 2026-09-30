"use client";
import { useActionState, useState } from "react";
import { Alert, Button, Field, Input, Textarea } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import {
  addKeywordsAction, createCampaignAction, endCampaignAction, pauseCampaignAction, removeKeywordAction, resumeCampaignAction, submitCampaignAction, updateBudgetAction, type AdsResult,
} from "./actions";
import { inr } from "./format";

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
  { id: "search", label: "Search results" },
  { id: "category", label: "Category pages" },
  { id: "product_similar", label: "Sponsored similar (on product pages)" },
] as const;

/**
 * Campaign builder. Sections read top to bottom like a stepper (setup, products, targeting, review), with a live cost preview
 * beside them. Nothing is pre-ticked except the two search surfaces, and submitting only sends the campaign for review:
 * nothing is charged until buyers actually click.
 */
export function NewCampaignForm({ products, categories, minDailyRupees, cpcSearchPaise, today }: { products: ProductChoice[]; categories: CategoryChoice[]; minDailyRupees: number; cpcSearchPaise: number | null; today: string }) {
  const [state, action] = useActionState<AdsResult | null, FormData>(createCampaignAction, null);
  const [daily, setDaily] = useState<number>(Math.max(minDailyRupees, 250));
  const tooLow = daily < minDailyRupees;
  const maxClicks = cpcSearchPaise ? Math.floor((daily * 100) / cpcSearchPaise) : null;
  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-10">
        <section aria-labelledby="s1" className="space-y-4">
          <h2 id="s1" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">1.</span>Setup</h2>
          <Field label="Campaign name" htmlFor="name" error={fieldError(state, "name")}><Input id="name" name="name" required minLength={2} maxLength={120} placeholder="e.g. Festival gifting boxes" /></Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Daily budget</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Budget presets">
              {PRESETS.map((p) => (
                <Button key={p} type="button" variant={daily === p ? "primary" : "outline"} className="min-h-11" onClick={() => setDaily(p)} aria-pressed={daily === p}>₹{p.toLocaleString("en-IN")}</Button>
              ))}
            </div>
            <Field label="Or enter an amount (₹ per day)" htmlFor="dailyRupees" error={fieldError(state, "dailyRupees")} hint={`Minimum ₹${minDailyRupees}. We never charge more than this in a day, even if more buyers click.`}>
              <Input id="dailyRupees" name="dailyRupees" type="number" inputMode="numeric" min={minDailyRupees} step={1} value={daily} onChange={(e) => setDaily(Number(e.target.value))} required />
            </Field>
            {tooLow ? <Alert tone="warning">The minimum daily budget is ₹{minDailyRupees}.</Alert> : null}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Total budget (optional)" htmlFor="totalRupees" hint="Stops the campaign when reached."><Input id="totalRupees" name="totalRupees" type="number" inputMode="numeric" min={0} /></Field>
            <Field label="Start date" htmlFor="startsAt" error={fieldError(state, "startsAt")}><Input id="startsAt" name="startsAt" type="date" defaultValue={today} min={today} required /></Field>
            <Field label="End date (optional)" htmlFor="endsAt" hint="Leave empty to run until you pause it."><Input id="endsAt" name="endsAt" type="date" min={today} /></Field>
          </div>
        </section>

        <section aria-labelledby="s2" className="space-y-3">
          <h2 id="s2" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">2.</span>Products to advertise</h2>
          <p className="text-sm text-muted">Only your published, approved products with an approved photo can run. Your product card is the ad: no custom text, so nothing can be misleading.</p>
          {products.length ? (
            <ul className="divide-y divide-line rounded-card border border-line bg-surface">
              {products.map((p) => (
                <li key={p.id} className="flex items-start gap-3 p-3">
                  <input id={`p-${p.id}`} type="checkbox" name="listingId" value={p.id} className="mt-1 size-5" />
                  <label htmlFor={`p-${p.id}`} className="text-sm text-ink">
                    {p.title}
                    {!p.eligible ? <span className="block text-xs text-muted">{p.note} It will not run until this is fixed.</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          ) : <Alert tone="info">You have no products yet. Publish a product first.</Alert>}
        </section>

        <section aria-labelledby="s3" className="space-y-4">
          <h2 id="s3" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">3.</span>Targeting</h2>
          <Field
            label="Keywords"
            htmlFor="keywords"
            error={fieldError(state, "keywords")}
            hint="One per line. Add [exact], [phrase] or [broad] at the end to set the match (default phrase). Start a line with - for words that must never trigger your ad. Our team reviews every keyword; brand names you do not own are not approved."
          >
            <Textarea id="keywords" name="keywords" rows={5} placeholder={"cosmetic boxes\nlipstick packaging [exact]\n-free sample"} />
          </Field>
          {categories.length ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">Categories (optional)</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {categories.map((c) => (
                  <label key={c.id} className="flex min-h-11 items-center gap-2 text-sm text-ink"><input type="checkbox" name="categoryId" value={c.id} className="size-5" />{c.name}</label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Where it can appear</legend>
            {SURFACES.map((s) => (
              <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm text-ink"><input type="checkbox" name="surface" value={s.id} defaultChecked={s.id !== "product_similar"} className="size-5" />{s.label}</label>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="States (optional)" htmlFor="state" hint="Leave empty for all of India. Type one state, e.g. Gujarat."><Input id="state" name="state" /></Field>
            <Field label="Pincode prefixes (optional)" htmlFor="pincodes" hint="First 3 digits, separated by commas, e.g. 560, 380."><Input id="pincodes" name="pincodes" /></Field>
          </div>
        </section>

        <section aria-labelledby="s4" className="space-y-3">
          <h2 id="s4" className="text-lg font-bold text-ink"><span className="mr-2 text-muted">4.</span>Review and send</h2>
          <FormAlert state={state} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton name="intent" value="submit" pendingText="Sending…" disabled={tooLow}>Send for review</SubmitButton>
            <SubmitButton name="intent" value="draft" variant="outline" pendingText="Saving…">Save as draft</SubmitButton>
          </div>
        </section>
      </div>

      <aside aria-label="Cost preview" className="h-fit space-y-3 rounded-card border border-line bg-surface p-4 lg:sticky lg:top-6">
        <h2 className="text-base font-bold text-ink">What this costs</h2>
        <dl className="space-y-2 text-sm">
          <div><dt className="text-muted">Price per click (search)</dt><dd className="font-semibold text-ink">{cpcSearchPaise ? inr(cpcSearchPaise) : "Set by category, shown after review"}</dd></div>
          <div><dt className="text-muted">Most you can spend in a day</dt><dd className="font-semibold text-ink">{inr(daily * 100)}</dd></div>
          {maxClicks !== null ? <div><dt className="text-muted">Clicks that budget buys, at most</dt><dd className="font-semibold text-ink">about {maxClicks.toLocaleString("en-IN")}</dd></div> : null}
        </dl>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          <li>You pay only when a real buyer clicks. Invalid clicks (bots, repeats, your own team) are free, and refunded automatically if found later.</li>
          <li>Paying does not change your verification badge or your normal search position. Your ad is always labelled &quot;Sponsored&quot;.</li>
          <li>Our team reviews new campaigns, usually within one business day. If an enquiry from an ad becomes a lead you accept, the normal lead credit applies as well.</li>
          <li>No commitment: pause or end at any time.</li>
        </ul>
      </aside>
    </form>
  );
}

function Act({ id, action, label, pending, variant = "outline", confirm }: { id: string; action: (p: AdsResult | null, fd: FormData) => Promise<AdsResult>; label: string; pending: string; variant?: "outline" | "primary" | "danger"; confirm?: string }) {
  const [state, act] = useActionState<AdsResult | null, FormData>(action, null);
  const [asking, setAsking] = useState(false);
  if (confirm && !asking) return <Button variant={variant} className="min-h-11" onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <form action={act} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      {confirm ? <p className="text-sm text-ink">{confirm}</p> : null}
      <div className="flex gap-2">
        <SubmitButton variant={variant} pendingText={pending}>{confirm ? `Yes, ${label.toLowerCase()}` : label}</SubmitButton>
        {confirm ? <Button variant="ghost" className="min-h-11" onClick={() => setAsking(false)}>Cancel</Button> : null}
      </div>
      <FormAlert state={state} />
    </form>
  );
}

export function CampaignControls({ id, status }: { id: string; status: string }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      {status === "draft" || status === "rejected" ? <Act id={id} action={submitCampaignAction} label="Send for review" pending="Sending…" variant="primary" /> : null}
      {["approved", "active", "exhausted"].includes(status) ? <Act id={id} action={pauseCampaignAction} label="Pause" pending="Pausing…" /> : null}
      {status === "paused" ? <Act id={id} action={resumeCampaignAction} label="Resume" pending="Resuming…" variant="primary" /> : null}
      {!["ended", "suspended"].includes(status) ? <Act id={id} action={endCampaignAction} label="End campaign" pending="Ending…" variant="danger" confirm="End this campaign for good? You can create a new one any time. Nothing more is charged." /> : null}
    </div>
  );
}

export function BudgetForm({ id, currentRupees, minRupees }: { id: string; currentRupees: number; minRupees: number }) {
  const [state, action] = useActionState<ActionResult<null> | null, FormData>(updateBudgetAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="id" value={id} />
      <Field label="Daily budget (₹)" htmlFor="dailyRupees" hint="Raising it above double sends the campaign back for review.">
        <Input id="dailyRupees" name="dailyRupees" type="number" inputMode="numeric" min={minRupees} defaultValue={currentRupees} required className="w-40" />
      </Field>
      <SubmitButton variant="outline" pendingText="Saving…">Update budget</SubmitButton>
      <div className="w-full"><FormAlert state={state} />{state?.ok ? <Alert tone="success">Budget updated.</Alert> : null}</div>
    </form>
  );
}

export function KeywordForm({ id }: { id: string }) {
  const [state, action] = useActionState<AdsResult | null, FormData>(addKeywordsAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <Field label="Add keywords" htmlFor="keywords" hint="One per line. New keywords are reviewed before they run; existing ones keep running.">
        <Textarea id="keywords" name="keywords" rows={3} />
      </Field>
      <SubmitButton variant="outline" pendingText="Adding…">Add keywords</SubmitButton>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">Added. They will run once approved.</Alert> : null}
    </form>
  );
}

export function RemoveKeyword({ id, keywordId, text }: { id: string; keywordId: string; text: string }) {
  const [state, action] = useActionState<AdsResult | null, FormData>(removeKeywordAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="keywordId" value={keywordId} />
      <SubmitButton variant="ghost" pendingText="…" aria-label={`Remove keyword ${text}`}>Remove</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}
