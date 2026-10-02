import { listApiKeysForStaff } from "@cnote/developer";
import { Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { FilterActions, FilterBar, FilterField, FilterInput, FilterSelect } from "@/components/filters";
import { Mono, Table, Td, Th } from "@/components/table";
import { revokeApiKeyAction } from "@/features/developers/actions";
import { RevokeKey } from "@/features/developers/revoke-button";
import { Sparkline } from "@/features/developers/sparkline";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, shortId } from "@/lib/util";

export const metadata = { title: "Developer keys" };

const STATUSES = ["active", "expired", "revoked"] as const;
const TONE = { active: "success", expired: "warning", revoked: "danger" } as const;

export default async function DevelopersPage({ searchParams }: PageProps<"/developers">) {
  const { staff } = await requireStaff("/developers", "api_keys.read");
  const sp = await searchParams;
  const q = one(sp.q);
  const status = STATUSES.find((s) => s === one(sp.status));
  const cursor = one(sp.cursor);
  const { items, nextCursor } = await listApiKeysForStaff({ q, status, cursor });
  const canRevoke = staff.privileges.includes("api_keys.revoke");
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) }).toString();

  return (
    <>
      <PageHeader title="Developer keys" description="Personal API keys across all users. Metadata and usage only: secrets are never stored or shown. Sparkline = daily requests, last 14 days." />
      <FilterBar label="Filter API keys">
        <FilterField label="Search" width="2xl"><FilterInput name="q" defaultValue={q} placeholder="name, prefix, key/person/business id" /></FilterField>
        <FilterField label="Status" width="md">
          <FilterSelect name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </FilterSelect>
        </FilterField>
        <FilterActions clearHref="/developers" clearLabel="Reset" />
      </FilterBar>
      {items.length === 0 ? <EmptyState title="No matching keys" /> : (
        <>
          <Table>
            <thead><tr><Th>Key</Th><Th>Owner</Th><Th>Scopes</Th><Th>Usage</Th><Th>Last used</Th><Th>Expires</Th><Th>Status</Th>{canRevoke ? <Th /> : null}</tr></thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id}>
                  <Td><p className="font-medium">{k.name}</p><Mono>{k.prefix}…</Mono></Td>
                  <Td>
                    <p>Person <Mono>{shortId(k.personId)}</Mono></p>
                    {k.businessId ? <Link href={`/businesses/${k.businessId}`} className="text-xs text-brand-700 hover:underline">Business {shortId(k.businessId)}</Link> : <span className="text-xs text-muted">no business</span>}
                  </Td>
                  <Td className="max-w-xs"><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} className="font-mono">{s}</Badge>)}</div></Td>
                  <Td><Sparkline values={k.usage} label={k.name} /></Td>
                  <Td className="whitespace-nowrap">{k.lastUsedAt ? <>{fmtDate(k.lastUsedAt)}{k.lastUsedIp ? <p className="font-mono text-xs text-muted">{k.lastUsedIp}</p> : null}</> : <span className="text-muted">never</span>}</Td>
                  <Td className="whitespace-nowrap">{k.expiresAt ? fmtDate(k.expiresAt) : <span className="text-muted">never</span>}</Td>
                  <Td><Badge tone={TONE[k.status]}>{k.status}</Badge>{k.revokedAt ? <p className="mt-1 text-xs text-muted">{fmtDate(k.revokedAt)}</p> : null}</Td>
                  {canRevoke ? <Td className="text-right">{k.status === "revoked" ? null : <RevokeKey id={k.id} name={k.name} action={revokeApiKeyAction} />}</Td> : null}
                </tr>
              ))}
            </tbody>
          </Table>
          {nextCursor ? <Link href={`/developers?${qs}`} className="text-sm text-brand-700 hover:underline">Older keys →</Link> : null}
        </>
      )}
    </>
  );
}
