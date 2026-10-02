"use client";
import type { AlertSettingsView } from "@cnote/alerts";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Card, CardBody } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState } from "react";
import { saveAlertSettingsAction } from "./actions";

const TYPES = [
  { field: "priceDrop", label: "priceDrop", text: "priceDropText" },
  { field: "backInStock", label: "backInStock", text: "backInStockText" },
  { field: "followedDigest", label: "followedDigest", text: "followedDigestText" },
] as const;

/** Opt-in toggles for each alert type (all default off) plus the channel choice. Native checkboxes, each with its own label and description. */
export function AlertSettingsForm({ settings, channels }: { settings: AlertSettingsView; channels: { in_app: boolean; email: boolean } }) {
  const t = useTranslations("retention");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveAlertSettingsAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Card>
        <CardBody>
          <fieldset className="flex flex-col gap-4">
            <legend className="text-base font-semibold text-ink">{t("alerts.title")}</legend>
            {TYPES.map((x) => (
              <div key={x.field} className="flex items-start gap-3">
                <input
                  id={`alert-${x.field}`}
                  type="checkbox"
                  name={x.field}
                  defaultChecked={settings[x.field]}
                  aria-describedby={`alert-${x.field}-text`}
                  className="mt-1 size-5 shrink-0 accent-brand-600"
                />
                <div>
                  <label htmlFor={`alert-${x.field}`} className="block min-h-6 text-sm font-medium text-ink">{t(`alerts.${x.label}`)}</label>
                  <p id={`alert-${x.field}-text`} className="text-sm text-muted">{t(`alerts.${x.text}`)}</p>
                </div>
              </div>
            ))}
            <p className="text-sm text-muted">
              {t("alerts.searchesText")}{" "}
              <Link href="/account/saved-searches" className="font-medium text-brand-700 underline">{t("alerts.searchesLink")}</Link>
            </p>
          </fieldset>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-base font-semibold text-ink">{t("alerts.channelsTitle")}</legend>
            <p className="text-sm text-muted">{t("alerts.channelsText")}</p>
            {(["in_app", "email"] as const).map((c) => (
              <label key={c} htmlFor={`channel-${c}`} className="flex min-h-11 items-center gap-3 text-sm font-medium text-ink">
                <input id={`channel-${c}`} type="checkbox" name={`channel:${c}`} defaultChecked={channels[c]} className="size-5 accent-brand-600" />
                {t(c === "in_app" ? "alerts.inApp" : "alerts.email")}
              </label>
            ))}
          </fieldset>
        </CardBody>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className="min-h-11" disabled={pending} aria-busy={pending}>{pending ? t("alerts.saving") : t("alerts.save")}</Button>
        <Link href="/account/notifications" className="text-sm font-medium text-brand-700 underline">{t("alerts.moreSettings")}</Link>
        <div role="status" aria-live="polite">
          {state?.ok ? <Alert tone="success">{t("alerts.saved")}</Alert> : null}
          {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        </div>
      </div>
    </form>
  );
}
