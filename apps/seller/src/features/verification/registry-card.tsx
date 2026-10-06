"use client";
import { useActionState } from "react";
import { BadgeCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert, Field, Input } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { verifyMcaAction, verifyUdyamAction, type RegistryResult } from "./actions";

interface Props {
  udyam: string | null; udyamVerifiedAt: string | null;
  cin: string | null; mcaVerifiedAt: string | null; mcaStatus: string | null;
  /** companies and LLPs have a CIN; proprietors and partnerships do not */
  showCin: boolean;
}

function Row({ kind, action, value, verifiedAt, label, hint, extra }: {
  kind: "udyam" | "mca"; action: (p: RegistryResult | null, f: FormData) => Promise<RegistryResult>; value: string | null; verifiedAt: string | null; label: string; hint: string; extra?: React.ReactNode;
}) {
  const t = useTranslations("verification.registry");
  const f = useFormatter();
  const [state, run] = useActionState<RegistryResult | null, FormData>(action, null);
  const d = state?.ok ? state.data : null;
  return (
    <form action={run} className="space-y-3">
      <Field label={label} htmlFor={`${kind}-number`} hint={hint} error={fieldError(state, "number")}>
        <Input id={`${kind}-number`} name="number" defaultValue={value ?? ""} autoCapitalize="characters" autoComplete="off" spellCheck={false} required className="h-11 font-mono" />
      </Field>
      <p className="flex items-center gap-1.5 text-sm text-muted" aria-live="polite">
        {verifiedAt ? <><BadgeCheck className="size-4 text-success" aria-hidden />{t("verifiedOn", { date: f.dateTime(new Date(verifiedAt), { dateStyle: "medium" }) })}</> : t("notVerified")}
      </p>
      {extra}
      <FormAlert state={state} />
      {d?.decision === "passed" ? <Alert tone="success">{t("passed")}</Alert> : null}
      {d?.decision === "review" ? <Alert tone="info">{t("review")}</Alert> : null}
      {d?.decision === "unavailable" ? <Alert tone="warning">{t("unavailable")}</Alert> : null}
      {d?.decision === "failed" ? <Alert tone="danger">{t("failed", { reason: d.reason ?? "" })}</Alert> : null}
      <SubmitButton pendingText={t("pending")}>{t("verify")}</SubmitButton>
    </form>
  );
}

export function RegistryCard({ udyam, udyamVerifiedAt, cin, mcaVerifiedAt, mcaStatus, showCin }: Props) {
  const t = useTranslations("verification.registry");
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">{t("intro")}</p>
      <Row kind="udyam" action={verifyUdyamAction} value={udyam} verifiedAt={udyamVerifiedAt} label={t("udyamLabel")} hint={t("udyamHint")} />
      {showCin ? (
        <Row
          kind="mca" action={verifyMcaAction} value={cin} verifiedAt={mcaVerifiedAt} label={t("cinLabel")} hint={t("cinHint")}
          extra={mcaStatus && mcaStatus !== "Active" ? <Alert tone="warning">{t("inactive", { status: mcaStatus })}</Alert> : null}
        />
      ) : null}
    </div>
  );
}
