"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useActionState, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { fileReportAction, type FiledReport } from "./report-action";
import { DETAILS_MAX, REPORT_TYPES, safePrefillUrl } from "./report";

export interface ReportFormLabels {
  url: string;
  urlHint: string;
  type: string;
  typeChoose: string;
  types: Record<(typeof REPORT_TYPES)[number], string>;
  name: string;
  email: string;
  emailHint: string;
  details: string;
  detailsHint: string;
  proof: string;
  proofHint: string;
  declaration: string;
  submit: string;
  submitting: string;
  done: string;
  doneBody: string;
}

const INITIAL = { type: "", name: "", email: "", details: "", proof: "" };

/**
 * Abuse / IPR report form. Every field is controlled so a validation error never wipes what the person typed (React 19
 * resets uncontrolled form fields after an action). `?url=` prefills the link (the product and supplier pages link here).
 * Labels come from the server page so this works on the static, locale-prefixed route without a client catalogue.
 */
export function ReportForm({ locale, labels }: { locale: string; labels: ReportFormLabels }) {
  const [state, action, pending] = useActionState<ActionResult<FiledReport> | null, FormData>(fileReportAction, null);
  const [v, setV] = useState(INITIAL);
  const [declared, setDeclared] = useState(false);

  // `?url=` is read in the browser (server snapshot is empty) so the page itself stays static.
  const prefill = useSyncExternalStore(
    () => () => undefined,
    () => safePrefillUrl(new URLSearchParams(window.location.search).get("url")),
    () => "",
  );
  const [urlTyped, setUrlTyped] = useState<string | null>(null);
  const url = urlTyped ?? prefill;

  const set = (k: keyof typeof INITIAL) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const onUrl = (e: ChangeEvent<HTMLInputElement>) => setUrlTyped(e.target.value);
  const fe = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  if (state?.ok) {
    return (
      <Alert tone="success">
        <p className="font-semibold">{labels.done}</p>
        <p className="mt-1">{labels.doneBody.replace("{id}", state.data.id)}</p>
      </Alert>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      <Field label={labels.url} htmlFor="report-url" hint={labels.urlHint} error={fe("url")}>
        <Input id="report-url" name="url" type="url" inputMode="url" autoComplete="off" maxLength={2000} required value={url} onChange={onUrl} />
      </Field>
      <Field label={labels.type} htmlFor="report-type" error={fe("type")}>
        <Select id="report-type" name="type" required value={v.type} onChange={set("type")}>
          <option value="" disabled>{labels.typeChoose}</option>
          {REPORT_TYPES.map((k) => <option key={k} value={k}>{labels.types[k]}</option>)}
        </Select>
      </Field>
      <Field label={labels.name} htmlFor="report-name" error={fe("name")}>
        <Input id="report-name" name="name" autoComplete="name" maxLength={120} required value={v.name} onChange={set("name")} />
      </Field>
      <Field label={labels.email} htmlFor="report-email" hint={labels.emailHint} error={fe("email")}>
        <Input id="report-email" name="email" type="email" autoComplete="email" maxLength={254} required value={v.email} onChange={set("email")} />
      </Field>
      <Field label={labels.details} htmlFor="report-details" hint={labels.detailsHint} error={fe("details")}>
        <Textarea id="report-details" name="details" rows={6} maxLength={DETAILS_MAX} required value={v.details} onChange={set("details")} />
      </Field>
      <Field label={labels.proof} htmlFor="report-proof" hint={labels.proofHint} error={fe("proof")}>
        <Input id="report-proof" name="proof" type="url" inputMode="url" autoComplete="off" maxLength={2000} value={v.proof} onChange={set("proof")} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-3">
          <input
            id="report-declaration"
            name="declaration"
            type="checkbox"
            className="mt-0.5 size-6 shrink-0 accent-brand-700"
            checked={declared}
            onChange={(e) => setDeclared(e.target.checked)}
            aria-invalid={fe("declaration") ? true : undefined}
            aria-describedby={fe("declaration") ? "report-declaration-error" : undefined}
            required
          />
          <label htmlFor="report-declaration" className="text-sm text-ink">{labels.declaration}</label>
        </div>
        {fe("declaration") ? <p id="report-declaration-error" role="alert" className="text-xs text-danger">{fe("declaration")}</p> : null}
      </div>
      <div><Button type="submit" size="lg" disabled={pending}>{pending ? labels.submitting : labels.submit}</Button></div>
    </form>
  );
}
