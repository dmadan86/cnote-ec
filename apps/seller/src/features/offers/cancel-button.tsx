"use client";
import { useActionState } from "react";
import type { ActionResult } from "@cnote/next-kit";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { cancelOfferAction } from "./actions";

export function CancelOfferButton({ offerId, title }: { offerId: string; title: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(cancelOfferAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="offerId" value={offerId} />
      <SubmitButton variant="outline" pendingText="Ending…" aria-label={`End offer on ${title}`}>End offer</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}
