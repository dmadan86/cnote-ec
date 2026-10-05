"use client";
import { useEffect } from "react";
import { Alert, Button, buttonClasses, Container } from "@cnote/ui";
import { HtmlLang } from "@/i18n/html-shell";
import { useFatalView } from "@/i18n/fatal-locale";

/**
 * Root error boundary: unlocalised routes and failures of a layout above the localised/(app) boundaries. It cannot assume a
 * next-intl provider (the locale layout may be what failed), so it takes copy and language from the URL (see fatal-locale.ts).
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { locale, copy, home } = useFatalView();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Container className="py-16">
      <HtmlLang locale={locale} />
      <div className="mx-auto max-w-lg text-center">
        <h1 className="text-2xl font-bold text-ink">{copy.errorTitle}</h1>
        <Alert tone="danger" className="mt-4 text-left">
          {copy.errorText}
        </Alert>
        <div className="mt-6 flex justify-center gap-3">
          <Button size="lg" onClick={reset}>
            {copy.tryAgain}
          </Button>
          <a href={home} className={buttonClasses("outline", "lg")}>
            {copy.goHome}
          </a>
        </div>
      </div>
    </Container>
  );
}
