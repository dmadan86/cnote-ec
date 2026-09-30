"use client";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Alert, Button, buttonClasses, Container } from "@cnote/ui";
import { LocaleLink } from "@/i18n/link";

export default function LocaleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("errors");
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Container className="py-16">
      <div className="mx-auto max-w-lg text-center">
        <h1 className="text-2xl font-bold text-ink">{t("errorTitle")}</h1>
        <Alert tone="danger" className="mt-4 text-left">
          {t("errorText")}
        </Alert>
        <div className="mt-6 flex justify-center gap-3">
          <Button size="lg" onClick={reset}>
            {t("tryAgain")}
          </Button>
          <LocaleLink href="/" className={buttonClasses("outline", "lg")}>
            {t("goHome")}
          </LocaleLink>
        </div>
      </div>
    </Container>
  );
}
