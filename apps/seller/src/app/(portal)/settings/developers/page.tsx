import type { Metadata } from "next";
import { Alert, ApiKeysTable, Card, CardBody, CardHeader, CardTitle, CreateApiKeyForm, PageHeader } from "@cnote/ui";
import { listApiKeys, scopeGroupDefs, SELLER_FEATURES } from "@cnote/developer";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { createApiKeyAction, revokeApiKeyAction } from "@/features/developers/actions";

export const metadata: Metadata = { title: "Developers" };

export default async function DevelopersPage() {
  const session = await requireSeller("/settings/developers");
  const keys = await load(() => listApiKeys(session.personId));
  const apiBaseUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3003";

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Developers" description="API keys let your systems read leads and manage listings through the REST API or MCP server." />
      <Card>
        <CardHeader><CardTitle>Create an API key</CardTitle></CardHeader>
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
        <CardHeader><CardTitle>Your keys</CardTitle></CardHeader>
        <CardBody>
          {keys.ok ? (
            <ApiKeysTable
              keys={keys.data.map((k) => ({ ...k, businessName: k.businessId ? session.business.name : null }))}
              revokeAction={revokeApiKeyAction}
              emptyMessage="No API keys yet."
            />
          ) : <Alert tone="danger">{keys.error}</Alert>}
        </CardBody>
      </Card>
    </div>
  );
}
