import { BUYER_FEATURES, listApiKeys, scopeGroupDefs } from "@cnote/developer";
import { requireSession } from "@cnote/next-kit";
import { ApiKeysTable, Card, CardBody, CardHeader, CardTitle, Container, CreateApiKeyForm, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getRequestLocale } from "@/lib/request-locale";
import { createApiKeyAction, revokeApiKeyAction } from "@/features/developers/actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("developers") };
}

export default async function DevelopersPage() {
  const s = await requireSession("/account/developers");
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "account" });
  const keys = await listApiKeys(s.personId);
  const businessName = s.business?.name ?? null;
  const rows = keys.map((k) => ({ ...k, businessName: k.businessId ? businessName : null }));
  const apiBaseUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3003";

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("devTitle")} description={t("devDescription")} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <Card className="lg:order-2 lg:self-start">
          <CardHeader><CardTitle>{t("devCreate")}</CardTitle></CardHeader>
          <CardBody>
            <CreateApiKeyForm
              action={createApiKeyAction}
              groups={scopeGroupDefs(BUYER_FEATURES)}
              businesses={s.business ? [{ id: s.business.id, name: s.business.name }] : []}
              apiBaseUrl={apiBaseUrl}
            />
          </CardBody>
        </Card>
        <Card className="min-w-0 lg:order-1">
          <CardHeader><CardTitle>{t("devKeys")}</CardTitle></CardHeader>
          <CardBody>
            <ApiKeysTable keys={rows} revokeAction={revokeApiKeyAction} emptyMessage={t("devEmpty")} />
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}
