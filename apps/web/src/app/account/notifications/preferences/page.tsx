import { Alert, Container, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { requireSession } from "@cnote/next-kit";
import { PreferencesForm } from "@/features/notifications/preferences-form";
import { loadPreferenceRows } from "@/features/notifications/preference-rows";

export const metadata = { title: "Notification preferences" };

export default async function NotificationPreferencesPage() {
  const s = await requireSession("/account/notifications/preferences");
  const data = await loadPreferenceRows(s.personId).catch((err) => {
    console.error("[notifications] preferences load failed", err);
    return null;
  });
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title="Notification preferences"
        description="Choose how we reach you. In-app notifications appear under the bell."
        actions={<Link href="/account/notifications" className="text-sm font-medium text-brand-700 hover:underline">Back to notifications</Link>}
      />
      {data ? <PreferencesForm rows={data.rows} /> : <Alert tone="danger">We could not load your preferences right now. Please try again in a moment.</Alert>}
    </Container>
  );
}
