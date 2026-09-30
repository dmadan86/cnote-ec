"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { channelAction, listingOptInAction, orderDecisionAction, type OndcResult } from "./actions";

export function ChannelForm({ connected, termsVersion }: { connected: boolean; termsVersion: string }) {
  const t = useTranslations("ondc");
  const [state, action] = useActionState<OndcResult | null, FormData>(channelAction, null);
  return (
    <form action={action} className="space-y-3">
      <FormAlert state={state} />
      <input type="hidden" name="termsVersion" value={termsVersion} />
      {connected ? (
        <SubmitButton name="intent" value="disconnect" variant="outline" pendingText={t("disconnecting")}>{t("disconnect")}</SubmitButton>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="terms" className="mt-1 size-4" />
            <span>{t("termsText")}</span>
          </label>
          <SubmitButton name="intent" value="connect" pendingText={t("connecting")}>{t("connect")}</SubmitButton>
        </>
      )}
    </form>
  );
}

export function OptInButton({ listingId, optedIn }: { listingId: string; optedIn: boolean }) {
  const t = useTranslations("ondc");
  const [state, action] = useActionState<OndcResult | null, FormData>(listingOptInAction, null);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="optIn" value={optedIn ? "0" : "1"} />
      <SubmitButton variant={optedIn ? "outline" : "primary"} size="sm" pendingText={t("saving")}>{optedIn ? t("remove") : t("add")}</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}

export function OrderDecision({ orderId }: { orderId: string }) {
  const t = useTranslations("ondc");
  const [state, action] = useActionState<OndcResult | null, FormData>(orderDecisionAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="orderId" value={orderId} />
      <FormAlert state={state} />
      <div className="flex gap-2">
        <SubmitButton name="intent" value="accept" pendingText={t("accepting")}>{t("accept")}</SubmitButton>
        <SubmitButton name="intent" value="reject" variant="outline" pendingText={t("rejecting")}>{t("reject")}</SubmitButton>
      </div>
    </form>
  );
}
