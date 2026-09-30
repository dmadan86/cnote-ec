import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { domainSetupInfo, listDomains } from "@cnote/domains";
import { Alert, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader } from "@cnote/ui";
import { AutoRefresh } from "@/features/domains/domain-actions";
import { AddDomainForm } from "@/features/domains/add-domain-form";
import { DomainCard, isInProgress } from "@/features/domains/domain-card";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("storefront.domains");
  return { title: t("metaTitle") };
}
export const dynamic = "force-dynamic";

export default async function DomainsPage() {
  const t = await getTranslations("storefront.domains");
  const session = await requireSeller("/storefront/domains");
  const [domains, info] = await Promise.all([load(() => listDomains(session.business.id)), load(() => domainSetupInfo(session.business.id))]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<Link href="/storefront/analytics" className="text-sm font-medium text-brand-700 hover:underline">{t("viewTraffic")}</Link>}
      />
      {info.ok && !info.data.slug ? <Alert tone="warning">{t("setupFirst")}</Alert> : null}
      {info.ok && info.data.platformHost ? (
        <p className="text-sm text-muted">{t("freeAddress")} <code className="font-mono">{info.data.platformHost}</code></p>
      ) : null}

      {!domains.ok ? <Alert tone="danger">{domains.error}</Alert> : (
        <>
          <AutoRefresh active={domains.data.some((d) => isInProgress(d.status))} />
          {domains.data.length === 0 ? (
            <EmptyState title={t("emptyTitle")} description={t("emptyDesc")} />
          ) : (
            <ul className="grid gap-4">
              {domains.data.map((d) => (
                <li key={d.id}><DomainCard d={d} /></li>
              ))}
            </ul>
          )}
          <Card>
            <CardHeader><CardTitle>{t("connectTitle")}</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <AddDomainForm disabled={(info.ok && !info.data.slug) || domains.data.length >= (info.ok ? info.data.max : 3)} />
              <p className="text-xs text-muted">{t("limitNote", { max: info.ok ? info.data.max : 3 })}</p>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
