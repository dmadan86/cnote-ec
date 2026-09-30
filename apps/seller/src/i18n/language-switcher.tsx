"use client";
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useRef } from "react";
import { LOCALES, LOCALE_NATIVE } from "./config";
import { setLocaleAction } from "./actions";

/** Compact language picker; submits on change (with a button fallback for no-JS). */
export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations("shell");
  const locale = useLocale();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setLocaleAction} className={className}>
      <label htmlFor={id} className="sr-only">{t("language")}</label>
      <div className="flex items-center gap-1.5">
        <Languages className="size-4 text-muted" aria-hidden />
        <select
          id={id}
          name="locale"
          defaultValue={locale}
          onChange={() => form.current?.requestSubmit()}
          className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>{LOCALE_NATIVE[l]}</option>
          ))}
        </select>
        <noscript><button type="submit" className="text-sm underline">{t("apply")}</button></noscript>
      </div>
    </form>
  );
}
