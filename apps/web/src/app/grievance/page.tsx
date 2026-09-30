import { grievancePolicy } from "@cnote/compliance";
import { currentSession } from "@cnote/next-kit";
import { Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { GrievanceForm } from "./grievance-form";

export const metadata = { title: "Grievance redressal", description: "Raise a privacy, data or content grievance with our Grievance Officer." };

export default async function GrievancePage() {
  const s = await currentSession();
  const policy = grievancePolicy();
  const name = process.env.GRIEVANCE_OFFICER_NAME;
  const email = process.env.GRIEVANCE_OFFICER_EMAIL;
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title="Grievance redressal" description="Raise a concern about your personal data, your consent, or content on the platform." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Submit a grievance</CardTitle></CardHeader>
            <CardBody><GrievanceForm signedIn={!!s} email={s?.email ?? null} /></CardBody>
          </Card>
        </div>
        <aside aria-labelledby="officer-heading" className="flex flex-col gap-6">
          <Card>
            <CardHeader><CardTitle><span id="officer-heading">Grievance Officer</span></CardTitle></CardHeader>
            <CardBody className="flex flex-col gap-2 text-sm">
              {name || email ? (
                <>
                  {name ? <p className="font-medium text-ink">{name}</p> : null}
                  {email ? <p><a className="text-brand-700 underline" href={`mailto:${email}`}>{email}</a></p> : null}
                </>
              ) : (
                <p className="text-muted">Use the form on this page; it goes straight to our Grievance Officer.</p>
              )}
              <p className="text-muted">
                We acknowledge every grievance within {policy.ackHours} hours and aim to resolve it within {policy.resolveDays} days. If you are not satisfied, you may complain to the Data Protection Board of India.
              </p>
            </CardBody>
          </Card>
          {s ? (
            <p className="text-sm"><Link className="text-brand-700 underline" href="/account/grievances">Track your grievances</Link></p>
          ) : (
            <p className="text-sm text-muted"><Link className="text-brand-700 underline" href="/signin?next=/account/grievances">Sign in</Link> to track the status of your grievances.</p>
          )}
        </aside>
      </div>
    </Container>
  );
}
