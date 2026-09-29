import { getConsents, listAuthSessions } from "@cnote/identity";
import { requireSession, signOutAction } from "@cnote/next-kit";
import { Badge, Button, buttonClasses, Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import { ConsentForm, DeleteAccountForm, PhoneVerification, ProfileForm } from "@/features/identity/forms";
import { signOutEverywhereAction } from "@/features/identity/actions";

export const metadata = { title: "Your account" };

export default async function AccountPage() {
  const s = await requireSession("/account");
  const [consents, sessions] = await Promise.all([getConsents(s.personId), listAuthSessions(s.personId, s.sessionId)]);
  const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title="Your account" description={s.business ? s.business.name : "Manage your profile, privacy and sign-in."} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <CardBody><ProfileForm name={s.name} preferredLanguage={s.preferredLanguage} email={s.email} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Phone verification</CardTitle>{s.phoneVerified ? <Badge tone="success">Verified</Badge> : <Badge>Not verified</Badge>}</CardHeader>
          <CardBody><PhoneVerification phone={s.phone} verified={s.phoneVerified} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Privacy and consents</CardTitle></CardHeader>
          <CardBody><ConsentForm consents={consents} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Active sessions</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-4">
            <ul className="divide-y divide-line text-sm">
              {sessions.map((x) => (
                <li key={x.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className="line-clamp-1 font-medium text-ink">{x.userAgent ?? "Unknown device"}</p>
                    <p className="text-xs text-muted">{x.ip ?? "IP unknown"} · last active {fmt.format(new Date(x.lastUsedAt))}</p>
                  </div>
                  {x.current ? <Badge tone="brand">This device</Badge> : null}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <form action={signOutAction}><Button type="submit" variant="outline">Sign out</Button></form>
              <form action={signOutEverywhereAction}><Button type="submit" variant="outline">Sign out everywhere</Button></form>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Download my data</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm text-muted">Get a JSON copy of your profile, businesses, consents and sessions.</p>
            {/* Plain anchor: a file download, not a page navigation. */}
            <a href="/account/export" className={buttonClasses("outline", "md", "self-start")}>Download JSON</a>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-danger">Delete account</CardTitle></CardHeader>
          <CardBody><DeleteAccountForm /></CardBody>
        </Card>
      </div>
    </Container>
  );
}
