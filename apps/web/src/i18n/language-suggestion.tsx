"use client";
import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { isLocalizedPath, LOCALE_META, LOCALES, localizePath, splitLocale, type Locale } from "./config";

const KEY = "cnote_lang_suggestion_dismissed";
const noopSubscribe = () => () => undefined;

/** Banner copy in each language (its audience reads it): [sentence, link text]. */
const COPY: Record<Locale, [string, string]> = {
  en: ["This page is also available in English. ", "View in English"],
  hi: ["यह पेज हिंदी में भी उपलब्ध है। ", "हिंदी में देखें"],
  kn: ["ಈ ಪುಟ ಕನ್ನಡದಲ್ಲಿಯೂ ಲಭ್ಯವಿದೆ. ", "ಕನ್ನಡದಲ್ಲಿ ವೀಕ್ಷಿಸಿ"],
  ta: ["இந்தப் பக்கம் தமிழிலும் கிடைக்கிறது. ", "தமிழில் பாருங்கள்"],
  te: ["ఈ పేజీ తెలుగులో కూడా అందుబాటులో ఉంది. ", "తెలుగులో చూడండి"],
  mr: ["हे पान मराठीतही उपलब्ध आहे. ", "मराठीत पहा"],
  gu: ["આ પેજ ગુજરાતીમાં પણ ઉપલબ્ધ છે. ", "ગુજરાતીમાં જુઓ"],
  bn: ["এই পেজটি বাংলাতেও পাওয়া যায়। ", "বাংলায় দেখুন"],
};

/** First supported non-default language in the browser's preference order, unless dismissed (client-only, no cookies). */
export function preferredLocale(languages: readonly string[]): Locale | null {
  for (const tag of languages) {
    const primary = tag?.toLowerCase().split("-")[0];
    const hit = LOCALES.find((l) => l === primary);
    if (hit) return hit;
  }
  return null;
}

function browserPreference(): Locale | null {
  try {
    if (localStorage.getItem(KEY)) return null;
    const p = preferredLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
    return p === "en" ? null : p; // an English-first visitor is never nudged away from the page they chose
  } catch {
    return null;
  }
}

/**
 * Non-redirecting suggestion. We never redirect on Accept-Language (crawlers and shared links must always get the
 * URL they asked for): after hydration, a page offers a dismissible link to the visitor's preferred language when
 * it differs from the page's. The text is in the target language with lang= set because its audience reads it.
 */
export function LanguageSuggestion() {
  const locale = useLocale();
  const t = useTranslations("lang");
  const pathname = usePathname();
  const prefers = useSyncExternalStore(noopSubscribe, browserPreference, () => null);
  const [dismissed, setDismissed] = useState(false);
  const { rest } = splitLocale(pathname);
  if (!prefers || prefers === locale || dismissed || !isLocalizedPath(rest)) return null;
  return (
    <div role="region" aria-label={t("label")} className="border-b border-line bg-brand-50 text-sm text-brand-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-1.5">
        <p>
          <span lang={LOCALE_META[prefers].bcp47}>{COPY[prefers][0]}</span>
          <a href={localizePath(rest, prefers)} hrefLang={LOCALE_META[prefers].hreflang} lang={LOCALE_META[prefers].bcp47} className="inline-flex min-h-8 items-center font-semibold underline">
            {COPY[prefers][1]}
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
