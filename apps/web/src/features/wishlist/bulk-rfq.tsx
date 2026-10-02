"use client";
// "Request quotes for selected": a checkbox on each saved product (linked to this form through the `form` attribute, so the
// per-item forms are not nested) and one submit. The server action sends one enquiry per supplier via @cnote/enquiry.
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useEffect, useId, useState } from "react";
import { requestQuotesForSelectedAction, type BulkRfqResult } from "./convenience-actions";

const FORM_ID = "bulk-rfq-form";
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${FORM_ID}"]`));

/** Checkbox for one saved product. */
export function SelectProduct({ listingId, title }: { listingId: string; title: string }) {
  const t = useTranslations("convenience");
  const id = useId();
  return (
    <div className="flex min-h-11 items-center">
      <input id={id} type="checkbox" name="listingId" value={listingId} form={FORM_ID} className="size-5 accent-[var(--color-brand-600,#6d28d9)]" />
      <label htmlFor={id} className="sr-only">
        {t("wishlist.selectItem", { title })}
      </label>
    </div>
  );
}

export function BulkRfqBar({ listId }: { listId: string }) {
  const t = useTranslations("convenience");
  const allId = useId();
  const [count, setCount] = useState(0);
  const [state, action, pending] = useActionState<ActionResult<BulkRfqResult> | null, FormData>(async (prev, fd) => {
    const result = await requestQuotesForSelectedAction(prev, fd);
    if (result.ok) {
      boxes().forEach((b) => (b.checked = false)); // sent: start the next selection clean
      setCount(0);
    }
    return result;
  }, null);

  useEffect(() => {
    const sync = () => setCount(boxes().filter((b) => b.checked).length);
    document.addEventListener("change", sync);
    return () => document.removeEventListener("change", sync);
  }, []);

  return (
    <form id={FORM_ID} action={action} className="rounded-card border border-accent-100 bg-accent-50 px-4 py-3">
      <input type="hidden" name="listId" value={listId} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-h-11 items-center gap-2">
          <input
            id={allId}
            type="checkbox"
            className="size-5"
            onChange={(e) => {
              boxes().forEach((b) => (b.checked = e.currentTarget.checked));
              setCount(e.currentTarget.checked ? boxes().length : 0);
            }}
          />
          <label htmlFor={allId} className="text-sm font-medium text-ink">
            {t("wishlist.selectAll")}
          </label>
        </div>
        <Button type="submit" variant="accent" disabled={pending || count === 0}>
          {pending ? t("wishlist.requesting") : count ? t("wishlist.requestSelectedCount", { count }) : t("wishlist.requestSelected")}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">{t("wishlist.bulkHint")}</p>
      <div role="status" aria-live="polite" className="mt-2 flex flex-col gap-1">
        {state?.ok ? (
          <>
            <p className="text-sm font-medium text-success">{t("wishlist.bulkDone", { created: state.data.created })}</p>
            {state.data.failed ? <p className="text-sm text-muted">{t("wishlist.bulkPartial", { failed: state.data.failed })}</p> : null}
            <Link href="/buyer/enquiries" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 hover:underline">
              {t("wishlist.viewEnquiries")}
            </Link>
          </>
        ) : null}
      </div>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
    </form>
  );
}
