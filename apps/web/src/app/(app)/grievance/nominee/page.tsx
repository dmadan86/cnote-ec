import { Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { NomineeRequestForm } from "@/features/nominee/forms";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "nominee" });
  return { title: t("reqTitle"), description: t("metaDescription") };
}

/** Public intake for a nominee (DPDP s.14): no account needed; the answer never reveals whether an account or nomination exists. */
export default async function NomineeRequestPage() {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "nominee" });
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("reqTitle")} description={t("reqIntro")} />
      <div className="max-w-2xl">
        <Card>
          <CardHeader><CardTitle>{t("reqTitle")}</CardTitle></CardHeader>
          <CardBody><NomineeRequestForm /></CardBody>
        </Card>
      </div>
      <p className="text-sm"><Link className="text-brand-700 underline" href="/grievance">{t("back")}</Link></p>
    </Container>
  );
}
