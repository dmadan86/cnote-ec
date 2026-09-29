"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
  return (
    <div className="flex flex-wrap items-start gap-2">
      {status !== "active" ? <ActionButton id={id} action={recheckDomainAction} label="Check again" pending="Checking…" ok="Check started. This page updates by itself." /> : null}
      {status === "active" && !isPrimary ? <ActionButton id={id} action={setPrimaryAction} label="Make primary" pending="Saving…" ok="Primary domain updated." /> : null}
      <ActionButton id={id} action={removeDomainAction} label="Remove" pending="Removing…" variant="danger" confirm={`Remove ${hostname}? Visitors will no longer reach your storefront through it.`} />
    </div>
  );
}

/** Refreshes the server-rendered page while a domain is still being verified, so status updates appear live. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [active, router]);
  return active ? <p role="status" className="text-xs text-muted">Checking automatically. You can leave this page open.</p> : null;
}
