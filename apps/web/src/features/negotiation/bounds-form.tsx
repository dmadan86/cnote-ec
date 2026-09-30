"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input } from "@cnote/ui";
import { useActionState } from "react";
import { setBoundsAction } from "./actions";
import type { NegotiationLabels } from "./labels";

export interface BoundsDefaults { targetRupees: number | null; ceilingRupees: number | null; maxLeadDays: number | null }

/** The buyer's limits. The assistant is server-side prevented from suggesting outside them. */
export function BoundsForm({ enquiryId, defaults, labels: t }: { enquiryId: string; defaults: BoundsDefaults; labels: NegotiationLabels }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(setBoundsAction, null);
  return (
    <form action={action} className="flex flex-col gap-3" aria-labelledby="neg-bounds-h">
      <h3 id="neg-bounds-h" className="text-base font-semibold text-ink">{t.boundsHeading}</h3>
      <p id="neg-bounds-hint" className="text-sm text-muted">{t.boundsHint}</p>
      <input type="hidden" name="enquiryId" value={enquiryId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t.boundsTarget} htmlFor="neg-target">
          <Input id="neg-target" name="target" inputMode="decimal" defaultValue={defaults.targetRupees ?? ""} aria-describedby="neg-bounds-hint" className="min-h-11" />
        </Field>
        <Field label={t.boundsMax} htmlFor="neg-ceiling">
          <Input id="neg-ceiling" name="ceiling" inputMode="decimal" defaultValue={defaults.ceilingRupees ?? ""} aria-describedby="neg-bounds-hint" className="min-h-11" />
        </Field>
        <Field label={t.boundsLead} htmlFor="neg-maxlead">
          <Input id="neg-maxlead" name="maxLead" inputMode="numeric" defaultValue={defaults.maxLeadDays ?? ""} aria-describedby="neg-bounds-hint" className="min-h-11" />
        </Field>
      </div>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{t.boundsSaved}</Alert> : null}
      <div>
        <Button type="submit" variant="outline" disabled={pending} aria-busy={pending} className="min-h-11">{pending ? t.boundsSaving : t.boundsSave}</Button>
      </div>
    </form>
  );
}
