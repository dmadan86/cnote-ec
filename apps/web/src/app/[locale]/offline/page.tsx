import { Container, buttonClasses } from "@cnote/ui";
import { WifiOff } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RetryButton } from "@/features/pwa/retry-button";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";

// Offline fallback served by public/sw.js when a navigation fails (ADR-004 low bandwidth). Static, never indexed.
export async function generateMetadata(props: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "help" });
  return { title: t("offlineTitle"), robots: { index: false, follow: false } };
}

export default async function OfflinePage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "help" });
  return (
    <Container className="max-w-xl py-16 text-center">
      <WifiOff className="mx-auto size-12 text-brand-700" aria-hidden />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{t("offlineTitle")}</h1>
      <p className="mt-2 text-base text-muted">{t("offlineBody")}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <RetryButton label={t("offlineRetry")} />
        <Link href="/help" className={buttonClasses("outline", "lg")}>
          {t("offlineHelp")}
        </Link>
      </div>
    </Container>
  );
}
