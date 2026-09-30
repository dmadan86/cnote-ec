"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, buttonClasses } from "@cnote/ui";
import { useActionState } from "react";
import { escrowAction } from "./actions";

export interface EscrowActionLabels { start: string; payMock: string; payMockHelp: string; payLink: string; accept: string; acceptHelp: string; error: string }

/** Only the actions the server says are allowed are rendered; the server re-checks on every call. */
export function EscrowActions(p: { orderId: string; labels: EscrowActionLabels; canStart: boolean; canPayMock: boolean; payLinkHref: string | null; canAccept: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(escrowAction, null);
  if (!p.canStart && !p.canPayMock && !p.payLinkHref && !p.canAccept) return null;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={p.orderId} />
      <div role="status" aria-live="polite">{state && !state.ok ? <Alert tone="danger">{state.error || p.labels.error}</Alert> : null}</div>
      <div className="flex flex-wrap items-center gap-3">
        {p.canStart ? <Button type="submit" name="intent" value="start" disabled={pending} className="min-h-11">{p.labels.start}</Button> : null}
        {p.canPayMock ? <Button type="submit" name="intent" value="pay_mock" disabled={pending} className="min-h-11">{p.labels.payMock}</Button> : null}
        {p.payLinkHref ? <a href={p.payLinkHref} className={buttonClasses("primary", "md", "min-h-11")}>{p.labels.payLink}</a> : null}
        {p.canAccept ? <Button type="submit" name="intent" value="accept" disabled={pending} className="min-h-11">{p.labels.accept}</Button> : null}
      </div>
      {p.canPayMock ? <p className="text-sm text-muted">{p.labels.payMockHelp}</p> : null}
      {p.canAccept ? <p className="text-sm text-muted">{p.labels.acceptHelp}</p> : null}
    </form>
  );
}
