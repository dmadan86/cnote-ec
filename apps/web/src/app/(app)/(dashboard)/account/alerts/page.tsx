import { getAlertSettings } from "@cnote/alerts";
import { requireSession } from "@cnote/next-kit";
import { getPreferences } from "@cnote/notifications";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getRequestLocale } from "@/lib/request-locale";
import { AlertSettingsForm } from "@/features/retention/alert-settings-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "retention" });
  return { title: t("alerts.title"), robots: { index: false } };
}

export default async function AlertsPage() {
  const s = await requireSession("/account/alerts");
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "retention" });
  const [settings, prefs] = await Promise.all([getAlertSettings(s.personId), getPreferences(s.personId)]);
  return (
    <Container className="flex max-w-3xl flex-col gap-6 py-8">
      <PageHeader title={t("alerts.title")} description={t("alerts.description")} />
      <AlertSettingsForm settings={settings} channels={{ in_app: prefs.alerts.in_app, email: prefs.alerts.email }} />
    </Container>
  );
}
