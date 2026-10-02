"use client";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useId, useTransition } from "react";
import { setLocaleAction } from "@/lib/locale-actions";
import { rememberLocale } from "./locale-cookie";
import { isLocale, isCookieLocalePath, isLocalizedPath, LOCALE_META, LOCALES, localizePath, splitLocale, type Locale } from "./config";

/**
 * Accessible language switcher: a native <select> with a visible <label>, `lang` on every <option> (so screen
 * readers pronounce each language name correctly) and a no-JS fallback list of plain links. It keeps the current
 * path (and query/hash). Every change stores the choice in the `cnote_locale` cookie (and as preferredLanguage when signed
 * in, via a server action). On localised pages it navigates to the other language's URL; on pages without a locale prefix
 * (account, buyer, rfq, sign-in, ...) the URL stays and the page refreshes in the new language.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const l = useLocale();
  const locale: Locale = isLocale(l) ? l : "en";
  const t = useTranslations("lang");
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const [, startTransition] = useTransition();
  const { rest } = splitLocale(pathname);
  const localizable = isLocalizedPath(rest);
  const cookieRoute = isCookieLocalePath(rest);
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
          rememberLocale(to); // immediate, so the next render already sees it
          startTransition(async () => {
            await setLocaleAction(to).catch(() => undefined); // persists preferredLanguage for a signed-in person
            if (localizable || !cookieRoute) router.push(`${target(to)}${localizable ? `${window.location.search}${window.location.hash}` : ""}`);
            else router.refresh();
          });
        }}
        className="min-h-11 rounded-md border border-current/30 lg:min-h-8 bg-transparent px-1.5 py-0.5 text-inherit focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={LOCALE_META[code].bcp47} className="text-ink">
            {LOCALE_META[code].native}
          </option>
        ))}
      </select>
      <noscript>
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
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
