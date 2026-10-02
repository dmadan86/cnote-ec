// DRAFT FOR COUNSEL REVIEW: the copy of this page (messages/*.legal.json, namespace legal.contact) is a working draft.
import { Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { ReactNode } from "react";
import { copyHelpers, legalMetadata } from "@/features/legal/legal-doc";
import { dialable, isPlaceholder } from "@/features/legal/entity";
import { LocaleLink } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";

export const generateMetadata = (props: { params: Promise<{ locale: string }> }) => legalMetadata(props.params, "/contact", "contact");
export const revalidate = 3600;

const linkCls = "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

export default async function ContactPage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const { t, rich, entity } = await copyHelpers(locale);
  const c = (k: string) => t(`contact.${k}`);
  const wa = dialable(entity.supportWhatsapp).replace(/^\+/, "");
  const row = (label: string, value: ReactNode) => (
    <div className="grid gap-0.5 sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-ink">{label}</dt>
      <dd className="text-sm text-muted sm:col-span-2">{value}</dd>
    </div>
  );
  const officerEmail = entity.grievanceOfficerEmail;
  return (
    <Container className="max-w-4xl py-10">
      <PageHeader title={c("title")} description={rich(t.raw("contact.intro") as string)} />
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="ct-support">
          <Card>
            <CardHeader><CardTitle><span id="ct-support">{c("supportTitle")}</span></CardTitle></CardHeader>
            <CardBody>
              <p className="text-sm text-muted">{c("supportBody")}</p>
              <dl className="mt-4 flex flex-col gap-3">
                {row(t("common.emailLabel"), isPlaceholder(entity.supportEmail) ? entity.supportEmail : <a className={linkCls} href={`mailto:${entity.supportEmail}`}>{entity.supportEmail}</a>)}
                {row(t("common.phoneLabel"), isPlaceholder(entity.supportPhone) ? entity.supportPhone : <a className={linkCls} href={`tel:${dialable(entity.supportPhone)}`}>{entity.supportPhone}</a>)}
                {row(t("common.whatsappLabel"), isPlaceholder(entity.supportWhatsapp) ? entity.supportWhatsapp : <a className={linkCls} href={`https://wa.me/${wa}`} rel="noopener noreferrer">{entity.supportWhatsapp}</a>)}
                {row(t("common.hoursLabel"), entity.supportHours)}
              </dl>
            </CardBody>
          </Card>
        </section>
        <section aria-labelledby="ct-entity">
          <Card>
            <CardHeader><CardTitle><span id="ct-entity">{c("entityTitle")}</span></CardTitle></CardHeader>
            <CardBody>
              <dl className="flex flex-col gap-3">
                {row(t("common.legalNameLabel"), entity.legalName)}
                {row(t("common.cinLabel"), entity.cin)}
                {row(t("common.gstinLabel"), entity.gstin)}
                {row(t("common.addressLabel"), <span className="whitespace-pre-line">{entity.address}</span>)}
              </dl>
            </CardBody>
          </Card>
        </section>
      </div>

      <section className="mt-8" aria-labelledby="ct-officer">
        <h2 id="ct-officer" className="text-lg font-semibold text-ink">{c("officerTitle")}</h2>
        <p className="mt-2 text-sm text-muted">{c("grievanceDesc")}</p>
        <dl className="mt-3 flex flex-col gap-3">
          {entity.grievanceOfficerName ? row(c("officerName"), entity.grievanceOfficerName) : null}
          {row(t("common.emailLabel"), <a className={linkCls} href={`mailto:${officerEmail ?? entity.supportEmail}`}>{officerEmail ?? entity.supportEmail}</a>)}
        </dl>
      </section>

      <section className="mt-8" aria-labelledby="ct-ways">
        <h2 id="ct-ways" className="text-lg font-semibold text-ink">{c("waysTitle")}</h2>
        <ul className="mt-3 grid gap-4 sm:grid-cols-2">
          {(
            [
              ["/grievance", t("links.grievance"), c("grievanceDesc")],
              ["/report", t("links.report"), c("reportDesc")],
              ["/pricing", c("salesTitle"), c("salesDesc")],
              ["/help", t("links.help"), c("helpDesc")],
            ] as const
          ).map(([href, label, desc]) => (
            <li key={href} className="rounded-card border border-line bg-surface p-4">
              <LocaleLink href={href} className={`${linkCls} inline-flex min-h-6 items-center`}>{label}</LocaleLink>
              <p className="mt-1 text-sm text-muted">{desc}</p>
            </li>
          ))}
        </ul>
      </section>
    </Container>
  );
}
