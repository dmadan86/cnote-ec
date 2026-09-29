import type { Metadata } from "next";
import Link from "next/link";
import { domainSetupInfo, listDomains } from "@cnote/domains";
import { Alert, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader } from "@cnote/ui";
import { AutoRefresh } from "@/features/domains/domain-actions";
import { AddDomainForm } from "@/features/domains/add-domain-form";
import { DomainCard, isInProgress } from "@/features/domains/domain-card";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";

export const metadata: Metadata = { title: "Custom domain" };
export const dynamic = "force-dynamic";

export default async function DomainsPage() {
  const session = await requireSeller("/storefront/domains");
  const [domains, info] = await Promise.all([load(() => listDomains(session.business.id)), load(() => domainSetupInfo(session.business.id))]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom domain"
        description="Serve your storefront on your own web address, like www.yourshop.in. We check your DNS, then set up HTTPS for you."
        actions={<Link href="/storefront/analytics" className="text-sm font-medium text-brand-700 hover:underline">View traffic</Link>}
      />
      {info.ok && !info.data.slug ? <Alert tone="warning">Set up your storefront first, then come back to connect a domain.</Alert> : null}
      {info.ok && info.data.platformHost ? (
        <p className="text-sm text-muted">Your free address is always available: <code className="font-mono">{info.data.platformHost}</code></p>
      ) : null}

      {!domains.ok ? <Alert tone="danger">{domains.error}</Alert> : (
        <>
          <AutoRefresh active={domains.data.some((d) => isInProgress(d.status))} />
          {domains.data.length === 0 ? (
            <EmptyState title="No custom domain yet" description="Buy a domain from any registrar, then connect it below. It takes about 5 minutes." />
          ) : (
            <ul className="grid gap-4">
              {domains.data.map((d) => (
                <li key={d.id}><DomainCard d={d} /></li>
              ))}
            </ul>
          )}
          <Card>
            <CardHeader><CardTitle>Connect a domain</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              <AddDomainForm disabled={(info.ok && !info.data.slug) || domains.data.length >= (info.ok ? info.data.max : 3)} />
              <p className="text-xs text-muted">You can connect up to {info.ok ? info.data.max : 3} domains. One of them is your primary domain; visitors on the others are sent there, which is best for Google.</p>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
