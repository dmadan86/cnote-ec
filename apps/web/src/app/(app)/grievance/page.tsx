import { grievancePolicy } from "@cnote/compliance";
import { currentSession } from "@cnote/next-kit";
import { Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getRequestLocale } from "@/lib/request-locale";
import { GrievanceForm } from "./grievance-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grievance" });
  return { title: t("title"), description: t("metaDescription") };
}

export default async function GrievancePage() {
  const s = await currentSession();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "grievance" });
  const tn = await getTranslations({ locale, namespace: "nominee" });
  const policy = grievancePolicy();
  const name = process.env.GRIEVANCE_OFFICER_NAME;
  const email = process.env.GRIEVANCE_OFFICER_EMAIL;
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>{t("submitTitle")}</CardTitle></CardHeader>
            <CardBody><GrievanceForm signedIn={!!s} email={s?.email ?? null} ackHours={policy.ackHours} /></CardBody>
          </Card>
        </div>
        <aside aria-labelledby="officer-heading" className="flex flex-col gap-6">
          <Card>
            <CardHeader><CardTitle><span id="officer-heading">{t("officer")}</span></CardTitle></CardHeader>
            <CardBody className="flex flex-col gap-2 text-sm">
              {name || email ? (
                <>
                  {name ? <p className="font-medium text-ink">{name}</p> : null}
                  {email ? <p><a className="break-all text-brand-700 underline" href={`mailto:${email}`}>{email}</a></p> : null}
                </>
              ) : (
                <p className="text-muted">{t("officerFallback")}</p>
              )}
              <p className="text-muted">{t("sla", { hours: policy.ackHours, days: policy.resolveDays })}</p>
              <p className="text-muted">{t("slaRights", { days: policy.rightsRequestDays })}</p>
            </CardBody>
          </Card>
          <p className="text-sm"><Link className="text-brand-700 underline" href="/grievance/nominee">{tn("reqTitle")}</Link></p>
          {s ? (
            <p className="text-sm"><Link className="text-brand-700 underline" href="/account/grievances">{t("track")}</Link></p>
          ) : (
            <p className="text-sm text-muted">
              {t.rich("signInToTrack", { link: (c) => <Link className="text-brand-700 underline" href="/signin?next=/account/grievances">{c}</Link> })}
            </p>
          )}
        </aside>
      </div>
    </Container>
  );
}
