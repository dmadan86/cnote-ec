import { listSellers } from "@cnote/identity";
import { Alert, EmptyState, PageHeader, TrustBadge } from "@cnote/ui";
import Link from "next/link";
import { FilterActions, FilterBar, FilterField, FilterInput } from "@/components/filters";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { one, safe } from "@/lib/util";

export const metadata = { title: "Businesses" };
const PAGE = 25;

export default async function BusinessesPage({ searchParams }: PageProps<"/businesses">) {
  await requireStaff("/businesses", "businesses.read");
  const sp = await searchParams;
  const q = one(sp.q)?.slice(0, 100);
  const city = one(sp.city)?.slice(0, 100);
  const page = Math.max(0, Math.min(1000, Number.parseInt(one(sp.page) ?? "0", 10) || 0));
  const rows = await safe("identity.listSellers", () => listSellers({ q, city, limit: PAGE + 1, offset: page * PAGE }));
  const qs = (p: number) => new URLSearchParams({ ...(q ? { q } : {}), ...(city ? { city } : {}), page: String(p) }).toString();
  return (
    <>
      <PageHeader title="Businesses" description="Sellers ranked by trust. Verified tier and badge come from the identity module, never from plan." />
      <p className="text-sm"><Link href="/businesses/gst-reviews" className="text-brand-700 hover:underline">GST review queue</Link> · <Link href="/businesses/registry-reviews" className="text-brand-700 hover:underline">Udyam / MCA review queue</Link></p>
      <FilterBar label="Search businesses">
        <FilterField label="Name" width="xl"><FilterInput name="q" defaultValue={q} placeholder="Search name…" /></FilterField>
        <FilterField label="City" width="md"><FilterInput name="city" defaultValue={city} placeholder="City" /></FilterField>
        <FilterActions submitLabel="Search" clearHref={q || city ? "/businesses" : undefined} />
      </FilterBar>
      {rows === null ? <Alert tone="warning">Business directory is currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No businesses found" /> : (
        <>
          <Table>
            <thead><tr><Th>Name</Th><Th>Location</Th><Th>Tier</Th><Th>Trust score</Th><Th>Badge</Th><Th /></tr></thead>
            <tbody>
              {rows.slice(0, PAGE).map((b) => (
                <tr key={b.businessId}>
                  <Td className="font-medium">{b.name}</Td>
                  <Td>{[b.city, b.state].filter(Boolean).join(", ") || "—"}</Td>
                  <Td>T{b.verificationTier}</Td>
                  <Td>{b.trustScore}</Td>
                  <Td><TrustBadge tier={b.verificationTier} badgeActive={b.badgeActive} /></Td>
                  <Td className="text-right"><Link href={`/businesses/${b.businessId}`} className="font-medium text-brand-700 hover:underline">Open</Link></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex justify-between text-sm">
            {page > 0 ? <Link href={`/businesses?${qs(page - 1)}`} className="text-brand-700 hover:underline">← Previous</Link> : <span />}
            {rows.length > PAGE ? <Link href={`/businesses?${qs(page + 1)}`} className="text-brand-700 hover:underline">Next →</Link> : null}
          </div>
        </>
      )}
    </>
  );
}
