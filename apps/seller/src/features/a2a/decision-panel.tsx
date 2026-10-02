"use client";
import { useTranslations } from "next-intl";
import { Alert } from "@cnote/ui";
import { negotiationDecisionAction } from "./actions";
import { IntentForm } from "./intent-form";

/**
 * Confirm / decline an agreed deal. "Nothing is committed until you confirm" is shown permanently, whatever the state,
 * so a seller never wonders whether the agent has already bound them (ADR-020).
 */
export function DecisionPanel({ id, status, canConfirm, realiseError }: { id: string; status: string; canConfirm: boolean; realiseError: string | null }) {
  const t = useTranslations("a2a");
  const w = t("controls.working");
  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-ink">{t("decision.notCommitted")}</p>
      {canConfirm ? (
        <div className="flex flex-wrap gap-3">
          <IntentForm action={negotiationDecisionAction} id={id} intent="confirm" label={t("decision.confirm")} pendingText={w} variant="primary" />
          <IntentForm action={negotiationDecisionAction} id={id} intent="decline" label={t("decision.decline")} pendingText={w} variant="outline" />
        </div>
      ) : null}
      {status === "agreed" && !canConfirm ? <p className="text-sm text-muted">{t("decision.waitingOther")}</p> : null}
      {realiseError ? (
        <Alert tone="danger">
          <p>{t("decision.realiseFailed")}</p>
          <p className="mt-1 text-xs">{realiseError}</p>
          <div className="mt-2"><IntentForm action={negotiationDecisionAction} id={id} intent="retry" label={t("decision.retry")} pendingText={w} /></div>
        </Alert>
      ) : null}
      {status === "open" || status === "agreed" ? (
        <IntentForm action={negotiationDecisionAction} id={id} intent="withdraw" label={t("decision.withdraw")} pendingText={w} variant="ghost" />
      ) : null}
    </div>
  );
}
