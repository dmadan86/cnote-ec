"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ActionResult } from "@cnote/next-kit";
import { Alert } from "@cnote/ui";
import { SubmitButton } from "@/features/shell/form-bits";
import { recheckDomainAction, removeDomainAction, setPrimaryAction } from "./actions";

type Act = (prev: ActionResult<null> | null, fd: FormData) => Promise<ActionResult<null>>;

function ActionButton({ id, action, label, pending, variant = "outline", confirm, ok }: { id: string; action: Act; label: string; pending: string; variant?: "outline" | "danger"; confirm?: string; ok?: string }) {
  const [state, formAction] = useActionState<ActionResult<null> | null, FormData>(action, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="space-y-1"
    >
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant={variant} pendingText={pending}>{label}</SubmitButton>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok && ok ? <p role="status" className="text-xs text-muted">{ok}</p> : null}
    </form>
  );
}

export function DomainActions({ id, hostname, status, isPrimary }: { id: string; hostname: string; status: string; isPrimary: boolean }) {
  const t = useTranslations("storefront.actions");
  return (
    <div className="flex flex-wrap items-start gap-2">
      {status !== "active" ? <ActionButton id={id} action={recheckDomainAction} label={t("recheck")} pending={t("rechecking")} ok={t("rechecked")} /> : null}
      {status === "active" && !isPrimary ? <ActionButton id={id} action={setPrimaryAction} label={t("makePrimary")} pending={t("saving")} ok={t("primaryUpdated")} /> : null}
      <ActionButton id={id} action={removeDomainAction} label={t("remove")} pending={t("removing")} variant="danger" confirm={t("removeConfirm", { host: hostname })} />
    </div>
  );
}

/** Refreshes the server-rendered page while a domain is still being verified, so status updates appear live. */
export function AutoRefresh({ active }: { active: boolean }) {
  const t = useTranslations("storefront.actions");
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [active, router]);
  return active ? <p role="status" className="text-xs text-muted">{t("autoRefresh")}</p> : null;
}
