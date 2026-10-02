"use client";
// One saved search on /account/saved-searches: change how often alerts arrive, or delete it. Plain forms (work without JavaScript
// for the initial render; the status line is announced politely).
import type { SearchFrequency } from "@cnote/alerts";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, buttonClasses, Card, CardBody } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState } from "react";
import { deleteSavedSearchAction, setSearchFrequencyAction } from "./actions";

export interface SavedSearchRowData {
  id: string;
  name: string;
  query: string;
  frequency: SearchFrequency;
  href: string;
  lastChecked: string | null;
  created: string;
}

export function SavedSearchRow({ s }: { s: SavedSearchRowData }) {
  const t = useTranslations("retention");
  const [fState, fAction, fPending] = useActionState<ActionResult | null, FormData>(setSearchFrequencyAction, null);
  const [dState, dAction, dPending] = useActionState<ActionResult | null, FormData>(deleteSavedSearchAction, null);
  const selectId = `freq-${s.id}`;
  return (
    <li>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words text-base font-semibold text-ink">{s.name}</h2>
              <p className="text-xs text-muted">
                {t("searches.created", { date: s.created })} · {s.lastChecked ? t("searches.lastChecked", { date: s.lastChecked }) : t("searches.neverChecked")}
              </p>
            </div>
            <Link href={s.href} className={buttonClasses("outline-brand", "md", "min-h-11")}>{t("searches.viewResults")}</Link>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <form action={fAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={s.id} />
              <div className="flex flex-col gap-1.5">
                <label htmlFor={selectId} className="text-sm font-medium text-ink">{t("searches.frequencyFor", { name: s.name })}</label>
                <select
                  id={selectId}
                  name="frequency"
                  defaultValue={s.frequency}
                  className="h-11 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                >
                  <option value="off">{t("searches.frequencyOff")}</option>
                  <option value="daily">{t("searches.frequencyDaily")}</option>
                  <option value="weekly">{t("searches.frequencyWeekly")}</option>
                </select>
              </div>
              <Button type="submit" variant="outline" className="min-h-11" disabled={fPending} aria-busy={fPending}>{t("searches.update")}</Button>
            </form>
            <form action={dAction}>
              <input type="hidden" name="id" value={s.id} />
              <Button type="submit" variant="ghost" className="min-h-11 text-danger" aria-label={t("searches.deleteLabel", { name: s.name })} disabled={dPending} aria-busy={dPending}>
                {t("searches.delete")}
              </Button>
            </form>
          </div>
          <div role="status" aria-live="polite">
            {fState?.ok ? <Alert tone="success">{t("searches.updated")}</Alert> : null}
            {fState && !fState.ok ? <Alert tone="danger">{fState.error}</Alert> : null}
            {dState && !dState.ok ? <Alert tone="danger">{dState.error}</Alert> : null}
          </div>
        </CardBody>
      </Card>
    </li>
  );
}
