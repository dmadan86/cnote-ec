"use client";
import { Alert, Card, CardBody } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import { savePreferencesAction } from "./actions";
import type { PreferenceRow } from "./preference-rows";

function Save() {
  const t = useTranslations("notif");
  const { pending } = useFormStatus();
  return <Button type="submit" className="min-h-11" disabled={pending} aria-busy={pending}>{pending ? t("saving") : t("save")}</Button>;
}

export function PreferencesForm({ rows }: { rows: PreferenceRow[] }) {
  const t = useTranslations("notif");
  const [state, action] = useActionState<ActionResult | null, FormData>(savePreferencesAction, null);
  return (
    <form action={action} className="space-y-4">
      {rows.map((row) => (
        <Card key={row.category}>
          <CardBody>
            <fieldset className="space-y-3">
              <legend className="text-base font-semibold text-ink">{t.has(`category.${row.category}.label`) ? t(`category.${row.category}.label`) : row.label}</legend>
              <p className="text-sm text-muted">{t.has(`category.${row.category}.description`) ? t(`category.${row.category}.description`) : row.description}</p>
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
                        {t.has(`channel.${c.channel}`) ? t(`channel.${c.channel}`) : c.label}
                      </label>
                      {c.locked === "required" ? <p id={noteId} className="text-xs text-muted">{t("alwaysOn")}</p> : null}
                      {c.locked === "consent" ? (
                        <p id={noteId} className="text-xs text-muted">
                          {t.rich("needsConsent", { link: (x) => <Link href="/account" className="font-medium text-brand-700 hover:underline">{x}</Link> })}
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
          {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
          {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        </div>
      </div>
    </form>
  );
}
