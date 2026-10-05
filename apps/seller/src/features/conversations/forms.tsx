"use client";
import { useActionState, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { DELIVERY_TERMS, PAYMENT_TERMS } from "./terms";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { UNITS } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { hasFileEntries, submitFormAsAction } from "@cnote/next-kit/upload-client";
import { intlTag } from "@/i18n/config";
import { suggestFreightAction } from "./freight";
import { LineQuoteFields } from "./line-quote-fields";
import type { EnquiryLineView } from "@cnote/enquiry";
import { reportDealAction, sendMessageAction, sendQuoteAction, type ConvResult } from "./actions";

export function MessageForm({ conversationId }: { conversationId: string }) {
  const t = useTranslations("leads.conversation");
  const ref = useRef<HTMLFormElement>(null);
  const [state, action] = useActionState<ConvResult | null, FormData>(async (prev, fd) => {
    const r = await sendMessageAction(prev, fd);
    if (r.ok) ref.current?.reset();
    return r;
  }, null);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <label htmlFor="body" className="sr-only">{t("messageLabel")}</label>
      <Textarea id="body" name="body" required maxLength={2000} placeholder={t("messagePlaceholder")} className="min-h-20 text-base" />
      <FormAlert state={state} />
      <SubmitButton pendingText={t("sending")}>{t("sendMessage")}</SubmitButton>
    </form>
  );
}

/** "Suggest freight": estimates from the quantity typed above and fills the delivery charge input; the seller can overwrite it. */
function SuggestFreight({ conversationId, formRef }: { conversationId: string; formRef: React.RefObject<HTMLFormElement | null> }) {
  const t = useTranslations("freight");
  const locale = useLocale();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inr = (paise: number) => new Intl.NumberFormat(intlTag(locale), { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
  function suggest() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData();
    fd.set("conversationId", conversationId);
    fd.set("quantity", String(new FormData(form).get("quantity") ?? ""));
    start(async () => {
      const r = await suggestFreightAction(null, fd);
      if (!r.ok) {
        setMsg({ ok: false, text: r.error });
        return;
      }
      const d = r.data;
      const input = form.elements.namedItem("deliveryCharge") as HTMLInputElement | null;
      if (input) input.value = (d.midPaise / 100).toFixed(2);
      const days = d.transitDays.min === d.transitDays.max ? String(d.transitDays.min) : `${d.transitDays.min}-${d.transitDays.max}`;
      const mode = t(d.mode === "parcel" ? "modeParcel" : d.mode === "ltl" ? "modeLtl" : "modeFtl");
      const note = d.assumptions.includes("weight_default") ? ` ${t("assumedWeight")}` : "";
      setMsg({ ok: true, text: `${t("suggestDone", { low: inr(d.lowPaise), high: inr(d.highPaise), mode, days, mid: inr(d.midPaise) })}${note}` });
    });
  }
  return (
    <div className="sm:col-span-2">
      <Button type="button" variant="outline" size="md" onClick={suggest} disabled={pending} aria-describedby="q-suggest-hint">
        {pending ? t("suggesting") : t("suggest")}
      </Button>
      <p id="q-suggest-hint" className="mt-1 text-xs text-muted">{t("suggestHint")}</p>
      <p role="status" aria-live="polite" className={`mt-1 text-sm ${msg && !msg.ok ? "text-danger" : "text-ink"}`}>{msg?.text}</p>
    </div>
  );
}

export function QuoteForm({ conversationId, lines }: { conversationId: string; lines?: EnquiryLineView[] }) {
  const multi = (lines?.length ?? 0) > 1;
  const t = useTranslations("leads.conversation");
  const tr = useTranslations("rfqLead");
  // Quotes WITH attachments post to /api/quotes (server actions are capped at 2 MB app-wide); text-only quotes use the server action.
  const [state, action] = useActionState<ConvResult | null, FormData>(
    async (prev, fd) => (hasFileEntries(fd) ? submitFormAsAction<null>("/api/quotes", fd) : sendQuoteAction(prev, fd)),
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} key={state?.ok ? "sent" : "draft"} className="space-y-4">
      <input type="hidden" name="conversationId" value={conversationId} />
      {multi ? <LineQuoteFields lines={lines!} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {multi ? null : (
          <>
            <Field label={t("price")} htmlFor="q-price" error={fieldError(state, "price")}>
              <Input id="q-price" name="price" inputMode="decimal" required className="h-11" />
            </Field>
            <Field label={t("quantity")} htmlFor="q-qty" error={fieldError(state, "quantity")}>
              <Input id="q-qty" name="quantity" inputMode="decimal" required className="h-11" />
            </Field>
            <Field label={t("unit")} htmlFor="q-unit" error={fieldError(state, "unit")}>
              <Select id="q-unit" name="unit" defaultValue="pcs" className="h-11">{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>
            </Field>
            <Field label={t("deliveryTime")} htmlFor="q-lead" error={fieldError(state, "leadTimeDays")}>
              <Input id="q-lead" name="leadTimeDays" inputMode="numeric" className="h-11" />
            </Field>
          </>
        )}
        <Field label={t("validUntil")} htmlFor="q-valid" error={fieldError(state, "validUntil")}>
          <Input id="q-valid" name="validUntil" type="date" className="h-11" />
        </Field>
      </div>
      <details className="rounded-lg border border-line p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand-700">{t("termsToggle")}</summary>
        <p className="mb-3 text-sm text-muted">{t("termsHint")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("moq")} htmlFor="q-moq" error={fieldError(state, "moq")}>
            <Input id="q-moq" name="moq" inputMode="numeric" className="h-11" />
          </Field>
          <Field label={t("gst")} htmlFor="q-gst">
            <Select id="q-gst" name="gstIncluded" defaultValue="" className="h-11">
              <option value="">{t("notStated")}</option>
              <option value="included">{t("gstIncluded")}</option>
              <option value="extra">{t("gstExtra")}</option>
            </Select>
          </Field>
          <Field label={t("deliveryTerms")} htmlFor="q-dterms">
            <Select id="q-dterms" name="deliveryTerms" defaultValue="" className="h-11">
              <option value="">{t("notStated")}</option>
              {DELIVERY_TERMS.map((k) => <option key={k} value={k}>{t(`delivery_${k}`)}</option>)}
            </Select>
          </Field>
          <Field label={t("deliveryCharge")} htmlFor="q-dcharge" error={fieldError(state, "deliveryCharge")}>
            <Input id="q-dcharge" name="deliveryCharge" inputMode="decimal" className="h-11" />
          </Field>
          <SuggestFreight conversationId={conversationId} formRef={formRef} />
          <Field label={t("deliveryNote")} htmlFor="q-dnote">
            <Input id="q-dnote" name="deliveryNote" maxLength={300} className="h-11" />
          </Field>
          <Field label={t("paymentTerms")} htmlFor="q-pterms">
            <Select id="q-pterms" name="paymentTerms" defaultValue="" className="h-11">
              <option value="">{t("notStated")}</option>
              {PAYMENT_TERMS.map((k) => <option key={k} value={k}>{t(`payment_${k}`)}</option>)}
            </Select>
          </Field>
          <Field label={t("paymentNote")} htmlFor="q-pnote">
            <Input id="q-pnote" name="paymentNote" maxLength={300} className="h-11" />
          </Field>
        </div>
      </details>
      <Field label={t("notes")} htmlFor="q-notes" hint={t("notesHint")} error={fieldError(state, "notes")}>
        <Textarea id="q-notes" name="notes" maxLength={1000} />
      </Field>
      <Field label={tr("quoteAttachments")} htmlFor="q-files" hint={tr("quoteAttachmentsHint")} error={fieldError(state, "attachments")}>
        <Input id="q-files" name="attachments" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className="h-auto min-h-11 py-2" />
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("quoteSent")}</Alert> : null}
      <SubmitButton variant="accent" size="lg" pendingText={t("sending")}>{t("sendQuote")}</SubmitButton>
    </form>
  );
}

export function DealReportForm({ conversationId, matchId, current }: { conversationId: string; matchId: string; current: "won" | "lost" | "pending" | null }) {
  const t = useTranslations("leads.conversation");
  const [state, action] = useActionState<ConvResult | null, FormData>(reportDealAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="matchId" value={matchId} />
      <Field label={t("dealValue")} htmlFor="d-value" hint={t("dealValueHint")} error={fieldError(state, "valueRupees")}>
        <Input id="d-value" name="valueRupees" inputMode="decimal" className="h-11 max-w-xs" />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton name="outcome" value="won" variant={current === "won" ? "primary" : "outline"} pendingText={t("saving")}>{t("yesClosed")}</SubmitButton>
        <SubmitButton name="outcome" value="pending" variant={current === "pending" ? "primary" : "outline"} pendingText={t("saving")}>{t("stillTalking")}</SubmitButton>
        <SubmitButton name="outcome" value="lost" variant={current === "lost" ? "primary" : "outline"} pendingText={t("saving")}>{t("noDeal")}</SubmitButton>
      </div>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("thanksNoted")}</Alert> : null}
    </form>
  );
}
