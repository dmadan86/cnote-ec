import { listMyNominees, MAX_ACTIVE_NOMINEES } from "@cnote/compliance";
import { requireSession } from "@cnote/next-kit";
import { Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { NomineeForm, RevokeNomineeForm } from "@/features/nominee/forms";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "nominee" });
  return { title: t("title") };
}

/** Right to nominate (DPDP s.14): add, change or remove the person who may exercise your data rights if you die or cannot act. */
export default async function NomineePage() {
  const s = await requireSession("/account/nominee");
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "nominee" });
  const nominees = await listMyNominees(s.personId);
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="grid gap-6 lg:grid-cols-2">
        {nominees.length === 0 ? <p className="text-sm text-muted lg:col-span-2">{t("empty")}</p> : null}
        {nominees.map((n) => (
          <Card key={n.id}>
            <CardHeader><CardTitle>{n.name}</CardTitle></CardHeader>
            <CardBody className="flex flex-col gap-6">
              <NomineeForm nominee={n} />
              <div className="border-t border-line pt-4"><RevokeNomineeForm id={n.id} /></div>
            </CardBody>
          </Card>
        ))}
        {nominees.length < MAX_ACTIVE_NOMINEES ? (
          <Card>
            <CardHeader><CardTitle>{t("add")}</CardTitle></CardHeader>
            <CardBody><NomineeForm /></CardBody>
          </Card>
        ) : (
          <p className="text-sm text-muted">{t("limit", { max: MAX_ACTIVE_NOMINEES })}</p>
        )}
      </div>
    </Container>
  );
}
