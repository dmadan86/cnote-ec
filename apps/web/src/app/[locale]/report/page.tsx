// DRAFT FOR COUNSEL REVIEW: the copy of this page (messages/*.legal.json, namespace legal.report) is a working draft.
import { Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import { ReportForm, type ReportFormLabels } from "@/features/legal/report-form";
import { REPORT_TYPES } from "@/features/legal/report";
import { copyHelpers, legalMetadata, Sections, type DocSection } from "@/features/legal/legal-doc";
import { resolveLocale } from "@/i18n/server";

export const generateMetadata = (props: { params: Promise<{ locale: string }> }) => legalMetadata(props.params, "/report", "report");
// Static: the `?url=` prefill is read in the browser by the form, so the page itself stays cacheable.
export const revalidate = 3600;

export default async function ReportPage(props: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(props.params);
  const { t, rich } = await copyHelpers(locale);
  const sections = t.raw("report.sections") as DocSection[];
  const f = (k: string) => t(`report.form.${k}`);
  const labels: ReportFormLabels = {
    url: f("url"),
    urlHint: f("urlHint"),
    type: f("type"),
    typeChoose: f("typeChoose"),
    types: Object.fromEntries(REPORT_TYPES.map((k) => [k, f(`type_${k}`)])) as ReportFormLabels["types"],
    name: f("name"),
    email: f("email"),
    emailHint: f("emailHint"),
    details: f("details"),
    detailsHint: f("detailsHint"),
    proof: f("proof"),
    proofHint: f("proofHint"),
    declaration: f("declaration"),
    submit: f("submit"),
    submitting: f("submitting"),
    done: f("done"),
    doneBody: t.raw("report.form.doneBody") as string,
  };
  return (
    <Container className="max-w-3xl py-10">
      <PageHeader title={t("report.title")} description={rich(t.raw("report.intro") as string)} />
      <div className="mt-8">
        <Card>
          <CardHeader><CardTitle>{f("heading")}</CardTitle></CardHeader>
          <CardBody><ReportForm locale={locale} labels={labels} /></CardBody>
        </Card>
      </div>
      <Sections sections={sections} rich={rich} />
    </Container>
  );
}
