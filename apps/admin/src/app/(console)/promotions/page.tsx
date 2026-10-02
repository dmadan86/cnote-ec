import { hasPrivilege } from "@cnote/admin";
import { listPromotions, PROMOTION_STATUSES, type PromotionStatusName } from "@cnote/promotions";
import { Alert, Badge, buttonClasses, EmptyState, LinkTabs, PageHeader, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Promotions" };
const TONE: Record<string, BadgeTone> = { draft: "neutral", in_review: "warning", approved: "success", archived: "neutral" };

export default async function PromotionsPage({ searchParams }: PageProps<"/promotions">) {
  const sp = await searchParams;
  const status = PROMOTION_STATUSES.find((s) => s === one(sp.status)) as PromotionStatusName | undefined;
  const { staff } = await requireStaff("/promotions", "promotions.read");
  const rows = await safe("promotions.list", () => listPromotions({ status }));
  return (
    <>
      <PageHeader
        title="Promotions"
        description="Editorial banners, collections and strips. Never sold: paid placement is an ad and lives elsewhere. Authors draft, a different person approves."
        actions={hasPrivilege(staff, "promotions.manage") ? <Link href="/promotions/new" className={buttonClasses("primary", "md", "shrink-0 whitespace-nowrap")}>New promotion</Link> : undefined}
      />
      <LinkTabs label="Status" items={[{ href: "/promotions", label: "All", active: !status }, ...PROMOTION_STATUSES.map((s) => ({ href: `/promotions?status=${s}`, label: s.replace("_", " "), active: s === status }))]} />
      {rows === null ? <Alert tone="warning">Promotions are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No promotions" description="Nothing matches this filter." /> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Type</Th><Th>Status</Th><Th>Surfaces</Th><Th>Window (IST)</Th><Th>Author</Th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <Td><Link href={`/promotions/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.internalName}</Link></Td>
                <Td>{p.kind.replace("_", " ")}</Td>
                <Td><Badge tone={TONE[p.status] ?? "neutral"}>{p.status.replace("_", " ")}</Badge></Td>
                <Td className="text-xs">{p.surfaces.join(", ")}</Td>
                <Td className="whitespace-nowrap text-xs">{fmtDate(p.startsAt)}<br />to {fmtDate(p.endsAt)}</Td>
                <Td className="font-mono text-xs">{p.createdBy.slice(0, 8)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
