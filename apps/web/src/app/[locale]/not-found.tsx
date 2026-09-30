"use client";
import { useTranslations } from "next-intl";
import { buttonClasses, Container } from "@cnote/ui";
import { LocaleLink } from "@/i18n/link";

export default function NotFound() {
  const t = useTranslations("errors");
  return (
    <Container className="py-20 text-center">
      <p className="text-sm font-semibold text-brand-700">{t("notFoundCode")}</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-ink">{t("notFoundTitle")}</h1>
      <p className="mx-auto mt-3 max-w-md text-muted">{t("notFoundText")}</p>
      <div className="mt-6 flex justify-center gap-3">
        <LocaleLink href="/" className={buttonClasses("primary", "lg")}>
          {t("goHome")}
        </LocaleLink>
        <LocaleLink href="/search" className={buttonClasses("outline", "lg")}>
          {t("searchProducts")}
        </LocaleLink>
      </div>
    </Container>
  );
}
