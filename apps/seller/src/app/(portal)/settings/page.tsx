import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { Button } from "@cnote/ui";
import { signOutAction } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { stateLabel } from "@/lib/states";
import { ConsentForm, ProfileForm } from "@/features/settings/forms";
import { signOutEverywhereAction } from "@/features/settings/actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("meta") };
}

export default async function SettingsPage() {
  const session = await requireSeller("/settings");
  const t = await getTranslations("settings");
  const ts = await getTranslations("states");
  const f = await getFormatter();
  const [consents, sessions, profile] = await Promise.all([
    load(() => identity.getConsents(session.personId)),
    load(() => identity.listAuthSessions(session.personId, session.sessionId, "seller")),
    load(async () => (await identity.getTrustProfiles([session.business.id])).get(session.business.id) ?? null),
  ]);

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title={t("title")} />

      <Card>
        <CardHeader><CardTitle>{t("profile.title")}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <ProfileForm name={session.name ?? ""} language={session.preferredLanguage} email={session.email} />
          <div className="border-t border-line pt-4 text-sm">
            <p className="font-medium text-ink">{session.business.name}</p>
            {profile.ok && profile.data ? (
              <p className="text-muted">{[profile.data.city, stateLabel(profile.data.state, (c) => (ts.has(c) ? ts(c) : undefined)), profile.data.pincode].filter(Boolean).join(", ") || t("profile.noAddress")}</p>
            ) : null}
            <p className="mt-1 text-muted">{session.phone ? t(session.phoneVerified ? "profile.phoneVerified" : "profile.phoneUnverified", { phone: session.phone }) : t("profile.phoneNone")}</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("consents.title")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-muted">{t("consents.intro")}</p>
          {consents.ok ? <ConsentForm granted={consents.data} /> : <Alert tone="danger">{consents.error}</Alert>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("sessions.title")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {!sessions.ok ? <Alert tone="danger">{sessions.error}</Alert> : (
            <ul className="divide-y divide-line">
              {sessions.data.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="min-w-0 truncate text-ink">{s.userAgent ?? t("sessions.unknown")}</span>
                  <span className="flex items-center gap-2 text-muted">
                    {s.current ? <Badge tone="brand">{t("sessions.thisDevice")}</Badge> : null}
                    {t("sessions.lastUsed", { date: f.dateTime(new Date(s.lastUsedAt), { dateStyle: "medium", timeStyle: "short" }) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <form action={signOutAction}><Button type="submit" variant="outline" className="min-h-11">{t("sessions.signOut")}</Button></form>
            <form action={signOutEverywhereAction}><Button type="submit" variant="outline" className="min-h-11">{t("sessions.signOutAll")}</Button></form>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
