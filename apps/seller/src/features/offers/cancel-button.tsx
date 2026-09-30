"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { ActionResult } from "@cnote/next-kit";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { cancelOfferAction } from "./actions";

export function CancelOfferButton({ offerId, title }: { offerId: string; title: string }) {
  const t = useTranslations("offers");
  const [state, action] = useActionState<ActionResult | null, FormData>(cancelOfferAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="offerId" value={offerId} />
      <SubmitButton variant="outline" pendingText={t("cancel.pending")} aria-label={t("cancel.aria", { title })}>{t("cancel.button")}</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}
