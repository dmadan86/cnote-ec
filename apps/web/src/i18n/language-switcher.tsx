"use client";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useId } from "react";
import { isLocale, isLocalizedPath, LOCALE_META, LOCALES, localizePath, splitLocale, type Locale } from "./config";

/**
 * Accessible language switcher: a native <select> with a visible <label>, `lang` on every <option> (so screen
 * readers pronounce each language name correctly) and a no-JS fallback list of plain links. It keeps the current
 * path (and query/hash); on pages that are not localised yet it goes to the other language's home page instead.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const l = useLocale();
  const locale: Locale = isLocale(l) ? l : "en";
  const t = useTranslations("lang");
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const { rest } = splitLocale(pathname);
  const localizable = isLocalizedPath(rest);
  const target = (to: Locale) => localizePath(localizable ? rest : "/", to);

  return (
    <div className={className}>
      <label htmlFor={id} className="mr-1.5">
        {t("label")}
      </label>
      <select
        id={id}
        value={locale}
        onChange={(e) => {
          const to = e.target.value as Locale;
          router.push(`${target(to)}${localizable ? `${window.location.search}${window.location.hash}` : ""}`);
        }}
        className="min-h-8 rounded-md border border-current/30 bg-transparent px-1.5 py-0.5 text-inherit focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={LOCALE_META[code].bcp47} className="text-ink">
            {LOCALE_META[code].native}
          </option>
        ))}
      </select>
      <noscript>
        <ul className="mt-1 flex gap-3">
          {LOCALES.map((code) => (
            <li key={code}>
              <a href={target(code)} hrefLang={LOCALE_META[code].hreflang} lang={LOCALE_META[code].bcp47}>
                {LOCALE_META[code].native}
              </a>
            </li>
          ))}
        </ul>
      </noscript>
    </div>
  );
}
