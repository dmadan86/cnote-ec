"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { unfollowAction } from "./actions";

/** Unfollow control on /buyer/suppliers. A plain form: works without JavaScript. */
export function UnfollowButton({ businessId, name }: { businessId: string; name: string }) {
  const t = useTranslations("retention");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(unfollowAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <Button type="submit" variant="outline" className="min-h-11" aria-label={t("suppliers.unfollowLabel", { name })} disabled={pending} aria-busy={pending}>
        {t("suppliers.unfollow")}
      </Button>
      <div role="status" aria-live="polite">{state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}</div>
    </form>
  );
}
