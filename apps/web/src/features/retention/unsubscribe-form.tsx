"use client";
import type { AlertType } from "@cnote/alerts";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, buttonClasses } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState } from "react";
import { unsubscribeAlertAction } from "./actions";

/** Confirmation step of the email unsubscribe link (a GET never changes anything: mail scanners prefetch links). */
export function UnsubscribeForm({ token, type }: { token: string; type: AlertType }) {
  const t = useTranslations("retention");
  const [state, action, pending] = useActionState<ActionResult<{ type: AlertType }> | null, FormData>(unsubscribeAlertAction, null);
  const label = { price_drop: "priceDrop", back_in_stock: "backInStock", followed_digest: "followedDigest", saved_search: "savedSearch" }[type];
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-ink">{t("unsubscribe.intro")} <strong>{t(`unsubscribe.${label}`)}</strong></p>
      {state?.ok ? null : (
        <div>
          <Button type="submit" className="min-h-11" disabled={pending} aria-busy={pending}>{pending ? t("unsubscribe.working") : t("unsubscribe.confirm")}</Button>
        </div>
      )}
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {state?.ok ? <Alert tone="success">{t("unsubscribe.done")}</Alert> : null}
        {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        {state?.ok ? <Link href="/account/alerts" className={buttonClasses("outline", "md", "min-h-11 self-start")}>{t("unsubscribe.settings")}</Link> : null}
      </div>
    </form>
  );
}
