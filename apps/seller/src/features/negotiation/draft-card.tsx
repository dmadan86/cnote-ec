"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Badge, Field, Input, Select, Textarea } from "@cnote/ui";
import { UNITS } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { approveDraftAction, discardDraftAction, requestDraftAction, type NegotiationResult } from "./actions";

export interface DraftCardData {
  id: string;
  conversationId: string;
  matchId: string;
  priceRupees: number;
  quantity: number;
  unit: string;
  leadTimeDays: number | null;
  validUntil: string | null;
  notes: string;
  rationale: string;
  confidence: number;
  needsReview: boolean;
  modelPriceRejected: boolean;
  floorRupees: number | null;
}

/** Pre-filled, editable quote draft. "Approve and send" is the only thing that sends anything to the buyer. */
export function DraftCard({ d }: { d: DraftCardData }) {
  const t = useTranslations("negotiation.draft");
  const [state, approve] = useActionState<NegotiationResult | null, FormData>(approveDraftAction, null);
  const [dState, discard] = useActionState<NegotiationResult | null, FormData>(discardDraftAction, null);
  return (
    <form action={approve} className="space-y-4" aria-describedby="draft-guard">
      <input type="hidden" name="draftId" value={d.id} />
      <input type="hidden" name="conversationId" value={d.conversationId} />
      <p id="draft-guard" className="text-sm text-muted">{t.rich("guard", { b: (c) => <strong>{c}</strong> })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.needsReview ? "warning" : "brand"}>{d.needsReview ? t("checkCarefully") : t("confidence", { percent: Math.round(d.confidence * 100) })}</Badge>
        {d.modelPriceRejected ? <Badge tone="warning">{t("belowLimit")}</Badge> : null}
      </div>
      <p className="rounded-lg bg-canvas p-3 text-sm text-ink"><span className="font-medium">{t("why")}</span>{d.rationale}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("price")} htmlFor="dr-price" hint={d.floorRupees != null ? t("floorHint", { floor: d.floorRupees }) : undefined} error={fieldError(state, "price")}>
          <Input id="dr-price" name="price" inputMode="decimal" required defaultValue={d.priceRupees} className="h-11" />
        </Field>
        <Field label={t("quantity")} htmlFor="dr-qty" error={fieldError(state, "quantity")}>
          <Input id="dr-qty" name="quantity" inputMode="numeric" required defaultValue={d.quantity} className="h-11" />
        </Field>
        <Field label={t("unit")} htmlFor="dr-unit" error={fieldError(state, "unit")}>
          <Select id="dr-unit" name="unit" defaultValue={d.unit} className="h-11">{[...new Set([d.unit, ...UNITS])].map((u) => <option key={u}>{u}</option>)}</Select>
        </Field>
        <Field label={t("lead")} htmlFor="dr-lead" error={fieldError(state, "leadTimeDays")}>
          <Input id="dr-lead" name="leadTimeDays" inputMode="numeric" defaultValue={d.leadTimeDays ?? ""} className="h-11" />
        </Field>
        <Field label={t("validUntil")} htmlFor="dr-valid" error={fieldError(state, "validUntil")}>
          <Input id="dr-valid" name="validUntil" type="date" defaultValue={d.validUntil ?? ""} className="h-11" />
        </Field>
      </div>
      <Field label={t("notes")} htmlFor="dr-notes" error={fieldError(state, "notes")}>
        <Textarea id="dr-notes" name="notes" maxLength={1000} defaultValue={d.notes} />
      </Field>
      <FormAlert state={state} />
      <FormAlert state={dState} />
      <div className="flex flex-wrap gap-3">
        <SubmitButton variant="accent" size="lg" pendingText={t("sending")}>{t("approve")}</SubmitButton>
        <SubmitButton variant="outline" size="lg" formAction={discard} formNoValidate pendingText={t("discarding")}>{t("discard")}</SubmitButton>
      </div>
    </form>
  );
}

export function RequestDraft({ matchId, conversationId }: { matchId: string; conversationId: string }) {
  const t = useTranslations("negotiation.draft");
  const [state, action] = useActionState<NegotiationResult | null, FormData>(requestDraftAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="matchId" value={matchId} />
      <input type="hidden" name="conversationId" value={conversationId} />
      <p className="text-sm text-muted">{t("requestHelp")}</p>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("requestDone")}</Alert> : null}
      <SubmitButton variant="outline" pendingText={t("drafting")}>{t("request")}</SubmitButton>
    </form>
  );
}
