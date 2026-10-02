"use client";
// "Save this search" on /search: stores the query + filters from the URL (never anything else) and optionally how often to be told
// about new matches. Alerts are opt-in: the default is "Don't alert me". Guests are sent to sign in. No browser storage is used.
import type { ActionResult } from "@cnote/next-kit";
import type { SearchFilters } from "@cnote/search";
import { Alert, Button, buttonClasses, Field, Input } from "@cnote/ui";
import { BookmarkPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { useUserState } from "@/features/user-state/store";
import { saveSearchAction } from "./actions";

export function SaveSearch({ q, filters, sort }: { q: string; filters: SearchFilters; sort: string }) {
  const t = useTranslations("retention");
  const u = useUserState();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [state, action, pending] = useActionState<ActionResult<{ id: string }> | null, FormData>(saveSearchAction, null);
  const saved = state?.ok === true;

  function onToggle() {
    if (!u.signedIn) {
      const next = `${window.location.pathname}${window.location.search}`;
      router.push(`/signin?next=${encodeURIComponent(next)}`);
      return;
    }
    setOpen((o) => !o);
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end" data-testid="save-search">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
        className={buttonClasses("outline", "md", "min-h-11")}
        data-testid="save-search-toggle"
      >
        <BookmarkPlus className="size-4" aria-hidden /> {u.status === "ready" && !u.signedIn ? t("searches.signIn") : t("searches.save")}
      </button>
      {open ? (
        <form
          id={panelId}
          action={action}
          className="flex w-full max-w-md flex-col gap-3 rounded-card border border-line bg-surface p-4 text-left"
          aria-label={t("searches.save")}
        >
          <input type="hidden" name="q" value={q} />
          <input type="hidden" name="filters" value={JSON.stringify(filters)} />
          <input type="hidden" name="sort" value={sort} />
          <p className="text-sm text-muted">{t("searches.saveHelp")}</p>
          <Field label={t("searches.nameLabel")} htmlFor="save-search-name">
            <Input id="save-search-name" name="name" maxLength={80} placeholder={t("searches.namePlaceholder")} autoComplete="off" />
          </Field>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-ink">{t("searches.frequencyLabel")}</legend>
            {(["off", "daily", "weekly"] as const).map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-3 text-sm text-ink">
                <input type="radio" name="frequency" value={f} defaultChecked={f === "off"} className="size-5 accent-brand-600" />
                {t(`searches.frequency${f === "off" ? "Off" : f === "daily" ? "Daily" : "Weekly"}`)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || saved} aria-busy={pending}>
              {pending ? t("searches.saving") : t("searches.submit")}
            </Button>
          </div>
          <div role="status" aria-live="polite">
            {state?.ok ? (
              <Alert tone="success">
                {t("searches.saved")}{" "}
                <Link href="/account/saved-searches" className="font-medium text-brand-700 underline">{t("searches.manage")}</Link>
              </Alert>
            ) : null}
            {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
