"use client";
import { useTranslations } from "next-intl";
import { mandateStatusAction } from "./actions";
import { IntentForm } from "./intent-form";

/** Pause / resume / revoke. Revoking asks for a second click inside a disclosure and ends all running negotiations of the mandate. */
export function StatusControls({ id, status }: { id: string; status: string }) {
  const t = useTranslations("a2a");
  const live = status === "active" || status === "paused";
  if (!live) return <p className="text-sm text-muted">{t("mandate.closedNote")}</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        {status === "active" ? (
          <IntentForm action={mandateStatusAction} id={id} intent="pause" label={t("controls.pause")} pendingText={t("controls.working")} />
        ) : (
          <IntentForm action={mandateStatusAction} id={id} intent="resume" label={t("controls.resume")} pendingText={t("controls.working")} variant="primary" />
        )}
      </div>
      <details className="rounded-lg border border-line p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-danger">{t("controls.revokeSummary")}</summary>
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted">{t("controls.revokeWarning")}</p>
          <IntentForm action={mandateStatusAction} id={id} intent="revoke" label={t("controls.revoke")} pendingText={t("controls.working")} variant="danger" />
        </div>
      </details>
    </div>
  );
}
