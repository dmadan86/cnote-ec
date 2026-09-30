"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useActionState } from "react";
import { fileGrievanceAction, type FiledGrievance } from "./actions";

const CATEGORIES: { value: string; label: string }[] = [
  { value: "access", label: "Access my personal data" },
  { value: "correction", label: "Correct my personal data" },
  { value: "erasure", label: "Erase my personal data" },
  { value: "consent", label: "Consent or withdrawal of consent" },
  { value: "content", label: "Content or moderation complaint" },
  { value: "other", label: "Something else" },
];

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" });

export function GrievanceForm({ signedIn, email }: { signedIn: boolean; email: string | null }) {
  const [state, action, pending] = useActionState<ActionResult<FiledGrievance> | null, FormData>(fileGrievanceAction, null);
  const fe = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  if (state?.ok) {
    return (
      <Alert tone="success">
        <p className="font-semibold">Your grievance has been received.</p>
        <p className="mt-1">
          Reference: <code className="break-all">{state.data.id}</code>. We will acknowledge it within 24 hours and resolve it by {fmt.format(new Date(state.data.dueAt))}.
          {signedIn ? " You can follow its status under Your account, Grievances." : " Keep this reference; we will reply to the email address you gave."}
        </p>
      </Alert>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
      <Field label="What is your grievance about?" htmlFor="category" error={fe("category")}>
        <Select id="category" name="category" defaultValue="" required>
          <option value="" disabled>Choose a category</option>
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Select>
      </Field>
      <Field label="Email for our reply" htmlFor="contactEmail" hint={signedIn ? "Optional: we will use your account email if you leave this blank." : "Required so we can reply to you."} error={fe("contactEmail")}>
        <Input id="contactEmail" name="contactEmail" type="email" autoComplete="email" defaultValue={email ?? ""} required={!signedIn} />
      </Field>
      <Field label="Subject" htmlFor="subject" error={fe("subject")}>
        <Input id="subject" name="subject" maxLength={200} required />
      </Field>
      <Field label="Describe your grievance" htmlFor="body" hint="Include listing or order references where relevant. Do not include passwords or card details." error={fe("body")}>
        <Textarea id="body" name="body" rows={6} maxLength={5000} required />
      </Field>
      <div><Button type="submit" size="lg" disabled={pending}>{pending ? "Submitting…" : "Submit grievance"}</Button></div>
    </form>
  );
}
