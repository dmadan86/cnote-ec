import { Alert, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getRequestLocale } from "@/lib/request-locale";
import { requireSession } from "@cnote/next-kit";
import { PreferencesForm } from "@/features/notifications/preferences-form";
import { loadPreferenceRows } from "@/features/notifications/preference-rows";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("notificationPrefs") };
}

export default async function NotificationPreferencesPage() {
  const s = await requireSession("/account/notifications/preferences");
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "notif" });
  const data = await loadPreferenceRows(s.personId).catch((err) => {
    console.error("[notifications] preferences load failed", err);
    return null;
  });
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("prefsTitle")}
        description={t("prefsDescription")}
        actions={<Link href="/account/notifications" className="text-sm font-medium text-brand-700 hover:underline">{t("back")}</Link>}
      />
      {data ? <PreferencesForm rows={data.rows} /> : <Alert tone="danger">{t("prefsLoadError")}</Alert>}
    </Container>
  );
}
