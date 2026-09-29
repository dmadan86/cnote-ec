import { adminDomainCounts, adminListDomains, type DomainStatusName } from "@cnote/domains";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, type BadgeTone } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { DomainRowActions } from "@/features/domains/row-actions";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Custom domains" };

const STATUSES: DomainStatusName[] = ["pending_dns", "verifying", "verified", "provisioning_tls", "active", "misconfigured"];
const TONE: Record<string, BadgeTone> = { active: "success", misconfigured: "danger", pending_dns: "warning", verifying: "neutral", verified: "brand", provisioning_tls: "brand" };

export default async function DomainsPage({ searchParams }: PageProps<"/domains">) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === one(sp.status));
  const search = one(sp.q);
  await requireStaff(`/domains${status ? `?status=${status}` : ""}`, "storefronts.review");
  const [rows, counts] = await Promise.all([safe("domains.list", () => adminListDomains({ status, search, limit: 100 })), safe("domains.counts", () => adminDomainCounts())]);

  return (
    <>
      <PageHeader title="Custom domains" description="Seller domains connected to storefronts. Verification runs in the background; use Re-check to retry immediately." />
      <LinkTabs
        label="Status"
        items={[{ href: "/domains", label: "All", active: !status }, ...STATUSES.map((s) => ({ href: `/domains?status=${s}`, label: `${s.replace("_", " ")} (${counts?.[s] ?? 0})`, active: s === status }))]}
      />
      <form method="get" role="search" className="flex gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <label htmlFor="q" className="sr-only">Search hostname</label>
        <input id="q" name="q" defaultValue={search} placeholder="Search hostname" className="h-9 w-64 rounded-lg border border-line bg-surface px-3 text-sm" />
        <button type="submit" className="h-9 rounded-lg border border-line bg-surface px-3 text-sm">Search</button>
      </form>
      {rows === null ? <Alert tone="warning">Domains are currently unavailable.</Alert> : rows.length === 0 ? (
        <EmptyState title="No domains" description="Nothing matches this filter." />
      ) : (
        <Table>
          <thead><tr><Th>Hostname</Th><Th>Storefront</Th><Th>Status</Th><Th>Last error</Th><Th>Checks</Th><Th>Last checked</Th><Th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <Td><Mono>{d.hostname}</Mono>{d.isPrimary ? <Badge tone="accent" className="ml-2">Primary</Badge> : null}</Td>
                <Td><Mono>{d.storefrontSlug}</Mono></Td>
                <Td><Badge tone={TONE[d.status] ?? "neutral"}>{d.status.replace("_", " ")}</Badge></Td>
                <Td className="max-w-xs text-xs">
                  {d.lastError ?? "None"}
                  {d.diagnostics ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-brand-700">Observed DNS</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-canvas p-2">{JSON.stringify({ txt: d.diagnostics.dns.txt.observed, cname: d.diagnostics.dns.routing.observedCname, a: d.diagnostics.dns.routing.observedA, caa: d.diagnostics.dns.caa.records, edge: d.diagnostics.edge?.state, probe: d.diagnostics.probe }, null, 2)}</pre>
                    </details>
                  ) : null}
                </Td>
                <Td>{d.checkCount}</Td>
                <Td className="whitespace-nowrap">{d.lastCheckedAt ? fmtDate(d.lastCheckedAt) : "never"}</Td>
                <Td><DomainRowActions id={d.id} hostname={d.hostname} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
