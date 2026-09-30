import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { requireSeller } from "@/lib/auth";
import { PreferencesForm } from "@/features/notifications/preferences-form";
import { loadPreferenceRows } from "@/features/notifications/preference-rows";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("notifications.prefs");
  return { title: t("meta") };
}

export default async function NotificationPreferencesPage() {
  const s = await requireSeller("/notifications/preferences");
  const t = await getTranslations("notifications.prefs");
  const data = await loadPreferenceRows(s.personId).catch((err) => {
    console.error("[notifications] preferences load failed", err);
    return null;
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<Link href="/notifications" className="text-sm font-medium text-brand-700 hover:underline">{t("back")}</Link>}
      />
      {data ? <PreferencesForm rows={data.rows} /> : <Alert tone="danger">{t("loadFail")}</Alert>}
    </div>
  );
}
