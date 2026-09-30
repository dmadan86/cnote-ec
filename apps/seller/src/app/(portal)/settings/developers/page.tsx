import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, ApiKeysTable, Card, CardBody, CardHeader, CardTitle, CreateApiKeyForm, PageHeader } from "@cnote/ui";
import { listApiKeys, scopeGroupDefs, SELLER_FEATURES } from "@cnote/developer";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { createApiKeyAction, revokeApiKeyAction } from "@/features/developers/actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.developers");
  return { title: t("meta") };
}

export default async function DevelopersPage() {
  const session = await requireSeller("/settings/developers");
  const t = await getTranslations("settings.developers");
  const keys = await load(() => listApiKeys(session.personId));
  const apiBaseUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3003";

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <Card>
        <CardHeader><CardTitle>{t("createTitle")}</CardTitle></CardHeader>
        <CardBody>
          <CreateApiKeyForm
            action={createApiKeyAction}
            groups={scopeGroupDefs(SELLER_FEATURES)}
            businesses={[{ id: session.business.id, name: session.business.name }]}
            apiBaseUrl={apiBaseUrl}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("keysTitle")}</CardTitle></CardHeader>
        <CardBody>
          {keys.ok ? (
            <ApiKeysTable
              keys={keys.data.map((k) => ({ ...k, businessName: k.businessId ? session.business.name : null }))}
              revokeAction={revokeApiKeyAction}
              emptyMessage={t("empty")}
            />
          ) : <Alert tone="danger">{keys.error}</Alert>}
        </CardBody>
      </Card>
    </div>
  );
}
