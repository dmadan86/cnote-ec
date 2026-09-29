"use client";
import { Alert, Card, CardBody } from "@cnote/ui";
import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import { savePreferencesAction } from "./actions";
import type { PreferenceRow } from "./preference-rows";

function Save() {
  const { pending } = useFormStatus();
  return <Button type="submit" className="min-h-11" disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save preferences"}</Button>;
}

export function PreferencesForm({ rows }: { rows: PreferenceRow[] }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(savePreferencesAction, null);
  return (
    <form action={action} className="space-y-4">
      {rows.map((row) => (
        <Card key={row.category}>
          <CardBody>
            <fieldset className="space-y-3">
              <legend className="text-base font-semibold text-ink">{row.label}</legend>
              <p className="text-sm text-muted">{row.description}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {row.channels.map((c) => {
                  const id = `${row.category}-${c.channel}`;
                  const noteId = `${id}-note`;
                  return (
                    <div key={c.channel} className="space-y-1">
                      <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm font-medium text-ink">
                        <input
                          id={id}
                          type="checkbox"
                          name={`${row.category}:${c.channel}`}
                          defaultChecked={c.enabled}
                          disabled={c.locked !== null}
                          aria-describedby={c.locked ? noteId : undefined}
                          className="size-5 accent-brand-600"
                        />
                        {c.label}
                      </label>
                      {c.locked === "required" ? <p id={noteId} className="text-xs text-muted">Always on: security alerts protect your account and cannot be turned off.</p> : null}
                      {c.locked === "consent" ? (
                        <p id={noteId} className="text-xs text-muted">
                          Needs your consent to marketing communication. <Link href="/account" className="font-medium text-brand-700 hover:underline">Manage consents in your account privacy settings</Link>.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          </CardBody>
        </Card>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Save />
        <div role="status" aria-live="polite">
          {state?.ok ? <Alert tone="success">Preferences saved.</Alert> : null}
          {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        </div>
      </div>
    </form>
  );
}
