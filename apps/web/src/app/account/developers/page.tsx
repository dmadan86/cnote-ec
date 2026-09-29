import { BUYER_FEATURES, listApiKeys, scopeGroupDefs } from "@cnote/developer";
import { requireSession } from "@cnote/next-kit";
import { ApiKeysTable, Card, CardBody, CardHeader, CardTitle, Container, CreateApiKeyForm, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { createApiKeyAction, revokeApiKeyAction } from "@/features/developers/actions";

export const metadata: Metadata = { title: "Developers" };

export default async function DevelopersPage() {
  const s = await requireSession("/account/developers");
  const keys = await listApiKeys(s.personId);
  const businessName = s.business?.name ?? null;
  const rows = keys.map((k) => ({ ...k, businessName: k.businessId ? businessName : null }));
  const apiBaseUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3003";

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title="Developers" description="Personal API keys let your own tools use the marketplace REST API and MCP server on your behalf." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <Card className="lg:order-2 lg:self-start">
          <CardHeader><CardTitle>Create an API key</CardTitle></CardHeader>
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
          <CardHeader><CardTitle>Your keys</CardTitle></CardHeader>
          <CardBody>
            <ApiKeysTable keys={rows} revokeAction={revokeApiKeyAction} emptyMessage="You haven't created any API keys yet." />
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}
