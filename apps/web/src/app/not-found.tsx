"use client";
import { buttonClasses, Container } from "@cnote/ui";
import { HtmlLang } from "@/i18n/html-shell";
import { useFatalView } from "@/i18n/fatal-locale";

/**
 * Root 404: any URL no route matches (for example /hi/typo). It is prerendered once for every URL, so the language is taken
 * from the browser URL after hydration (see fatal-locale.ts) and <html lang> is corrected with it.
 */
export default function NotFound() {
  const { locale, copy, home, search } = useFatalView();
  return (
    <Container className="py-20 text-center">
      <HtmlLang locale={locale} />
      <p className="text-sm font-semibold text-brand-700">{copy.notFoundCode}</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-ink">{copy.notFoundTitle}</h1>
      <p className="mx-auto mt-3 max-w-md text-muted">{copy.notFoundText}</p>
      <div className="mt-6 flex justify-center gap-3">
        <a href={home} className={buttonClasses("primary", "lg")}>
          {copy.goHome}
        </a>
        <a href={search} className={buttonClasses("outline", "lg")}>
          {copy.searchProducts}
        </a>
      </div>
    </Container>
  );
}
