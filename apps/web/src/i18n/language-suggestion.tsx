"use client";
import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { isLocalizedPath, localizePath, splitLocale } from "./config";

const KEY = "cnote_lang_suggestion_dismissed";
const noopSubscribe = () => () => undefined;

/** True when the browser prefers Hindi and the visitor has not dismissed the suggestion (client-only, no cookies). */
function wantsHindi(): boolean {
  try {
    if (localStorage.getItem(KEY)) return false;
    return (navigator.languages?.length ? navigator.languages : [navigator.language]).some((l) => l?.toLowerCase().startsWith("hi"));
  } catch {
    return false;
  }
}

/**
 * Non-redirecting suggestion. We never redirect on Accept-Language (crawlers and shared links must always get the
 * URL they asked for): after hydration, an English page offers a dismissible link to the Hindi version. The link text
 * is Hindi with lang="hi" because its audience reads Hindi.
 */
export function LanguageSuggestion() {
  const locale = useLocale();
  const t = useTranslations("lang");
  const pathname = usePathname();
  const prefers = useSyncExternalStore(noopSubscribe, wantsHindi, () => false);
  const [dismissed, setDismissed] = useState(false);
  const { rest } = splitLocale(pathname);
  if (locale !== "en" || !prefers || dismissed || !isLocalizedPath(rest)) return null;
  return (
    <div role="region" aria-label={t("label")} className="border-b border-line bg-brand-50 text-sm text-brand-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-1.5">
        <p>
          <span lang="hi">यह पेज हिंदी में भी उपलब्ध है। </span>
          <a href={localizePath(rest, "hi")} hrefLang="hi-IN" lang="hi" className="inline-flex min-h-8 items-center font-semibold underline">
            हिंदी में देखें
          </a>
        </p>
        <button
          type="button"
          aria-label={t("dismiss")}
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-brand-100"
          onClick={() => {
            try {
              localStorage.setItem(KEY, "1");
            } catch {
              /* storage blocked: dismiss for this page view only */
            }
            setDismissed(true);
          }}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
