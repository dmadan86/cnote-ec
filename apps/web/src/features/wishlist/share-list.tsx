"use client";
// Share a list through a read-only public link. The link is an unguessable token; "Stop sharing" kills it at once.
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Input } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState, useSyncExternalStore } from "react";
import { revokeShareAction, startShareAction } from "./convenience-actions";

export function ShareList({ listId, token }: { listId: string; token: string | null }) {
  const t = useTranslations("convenience");
  const inputId = useId();
  // `local` lets the UI react at once to the action; until then (and after a reload) the server's `token` is the truth.
  const [local, setLocal] = useState<{ token: string | null } | null>(null);
  const [startState, start, starting] = useActionState<ActionResult<{ token: string }> | null, FormData>(async (prev, fd) => {
    const r = await startShareAction(prev, fd);
    if (r.ok) setLocal({ token: r.data.token });
    return r;
  }, null);
  const [revokeState, revoke, revoking] = useActionState<ActionResult | null, FormData>(async (prev, fd) => {
    const r = await revokeShareAction(prev, fd);
    if (r.ok) setLocal({ token: null });
    return r;
  }, null);
  const [copied, setCopied] = useState(false);
  const live = local ? local.token : token;
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
  const error = (startState && !startState.ok && startState.error) || (revokeState && !revokeState.ok && revokeState.error) || null;
  const url = live ? `${origin}/shared/${live}` : "";

  return (
    <details className="rounded-lg border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-brand-600">{t("wishlist.shareTitle")}</summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">
        <p className="text-sm text-muted">{live ? t("wishlist.shareOn") : t("wishlist.shareOff")}</p>
        {live ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={inputId} className="text-xs font-medium text-muted">
                  {t("wishlist.shareLinkLabel")}
                </label>
                <Input id={inputId} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 3000);
                  } catch {
                    document.getElementById(inputId)?.focus();
                  }
                }}
              >
                {t("wishlist.shareCopy")}
              </Button>
            </div>
            <p role="status" aria-live="polite" className="min-h-5 text-xs text-success">
              {copied ? t("wishlist.shareCopied") : ""}
            </p>
            <form
              action={revoke}
              onSubmit={(e) => {
                if (!window.confirm(t("wishlist.shareRevokeConfirm"))) e.preventDefault();
              }}
            >
              <input type="hidden" name="listId" value={listId} />
              <Button type="submit" variant="outline" disabled={revoking}>
                {revoking ? t("wishlist.shareRevoking") : t("wishlist.shareRevoke")}
              </Button>
            </form>
          </>
        ) : (
          <form action={start}>
            <input type="hidden" name="listId" value={listId} />
            <Button type="submit" variant="outline-brand" disabled={starting}>
              {starting ? t("wishlist.shareCreating") : t("wishlist.shareCreate")}
            </Button>
          </form>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </details>
  );
}
