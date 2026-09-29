import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { Button } from "@cnote/ui";
import { signOutAction } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { ConsentForm, ProfileForm } from "@/features/settings/forms";
import { signOutEverywhereAction } from "@/features/settings/actions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSeller("/settings");
  const [consents, sessions, profile] = await Promise.all([
    load(() => identity.getConsents(session.personId)),
    load(() => identity.listAuthSessions(session.personId)),
    load(async () => (await identity.getTrustProfiles([session.business.id])).get(session.business.id) ?? null),
  ]);

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" />

      <Card>
        <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <ProfileForm name={session.name ?? ""} language={session.preferredLanguage} email={session.email} />
          <div className="border-t border-line pt-4 text-sm">
            <p className="font-medium text-ink">{session.business.name}</p>
            {profile.ok && profile.data ? (
              <p className="text-muted">{[profile.data.city, profile.data.state, profile.data.pincode].filter(Boolean).join(", ") || "No address added"}</p>
            ) : null}
            <p className="mt-1 text-muted">Phone: {session.phone ? `${session.phone} ${session.phoneVerified ? "(verified)" : "(not verified)"}` : "not added"}</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Your data choices</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-muted">Each choice is separate and applies only to the purpose described. Withdrawing consent stops that use going forward.</p>
          {consents.ok ? <ConsentForm granted={consents.data} /> : <Alert tone="danger">{consents.error}</Alert>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Where you are signed in</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {!sessions.ok ? <Alert tone="danger">{sessions.error}</Alert> : (
            <ul className="divide-y divide-line">
              {sessions.data.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="min-w-0 truncate text-ink">{s.userAgent ?? "Unknown device"}</span>
                  <span className="flex items-center gap-2 text-muted">
                    {s.current ? <Badge tone="brand">This device</Badge> : null}
                    Last used {formatDateTime(s.lastUsedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <form action={signOutAction}><Button type="submit" variant="outline" className="min-h-11">Sign out</Button></form>
            <form action={signOutEverywhereAction}><Button type="submit" variant="outline" className="min-h-11">Sign out everywhere</Button></form>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
