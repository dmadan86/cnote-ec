"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Input } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { createListAction, deleteListAction, renameListAction } from "./actions";

export function CreateListForm() {
  const t = useTranslations("wishlist");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createListAction, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="flex flex-col gap-2">
      <label htmlFor="new-list" className="text-sm font-medium text-ink">
        {t("newList")}
      </label>
      <div className="flex gap-2">
        <Input id="new-list" name="name" required maxLength={80} placeholder={t("listPlaceholder")} autoComplete="off" />
        <Button type="submit" variant="outline-brand" disabled={pending}>
          {pending ? t("adding") : t("create")}
        </Button>
      </div>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
    </form>
  );
}

/** Rename / delete for a non-default list. */
export function ManageList({ listId, name, itemCount }: { listId: string; name: string; itemCount: number }) {
  const t = useTranslations("wishlist");
  const router = useRouter();
  const [renameState, rename, renaming] = useActionState<ActionResult | null, FormData>(renameListAction, null);
  const [delState, del, deleting] = useActionState<ActionResult | null, FormData>(deleteListAction, null);
  useEffect(() => {
    if (delState?.ok) router.replace("/wishlist");
  }, [delState, router]);
  const error = (renameState && !renameState.ok && renameState.error) || (delState && !delState.ok && delState.error) || null;
  return (
    <details className="rounded-lg border border-line bg-surface">
      <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-brand-600">{t("manage")}</summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">
        <form action={rename} className="flex gap-2">
          <input type="hidden" name="listId" value={listId} />
          <label htmlFor={`rename-${listId}`} className="sr-only">
            {t("listName")}
          </label>
          <Input id={`rename-${listId}`} name="name" defaultValue={name} required maxLength={80} />
          <Button type="submit" variant="outline" disabled={renaming}>
            {t("rename")}
          </Button>
        </form>
        <form
          action={del}
          onSubmit={(e) => {
            if (!window.confirm(t("deleteConfirm", { name, count: itemCount }))) e.preventDefault();
          }}
        >
          <input type="hidden" name="listId" value={listId} />
          <Button type="submit" variant="danger" size="sm" disabled={deleting}>
            {deleting ? t("deleting") : t("deleteList")}
          </Button>
        </form>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </details>
  );
}
